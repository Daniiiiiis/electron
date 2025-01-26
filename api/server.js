const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');

// Настройки подключения к БД (подставьте свои)
const pool = new Pool({
    host: 'localhost',
    port: 5433,
    database: 'postgres',
    user: 'postgres',
    password: '1408Dsr2006*'
});

// Установим search_path (если нужно)
pool.query('SET search_path TO "first session", public')
    .catch(err => console.error('Ошибка search_path:', err));

const app = express();
app.use(bodyParser.json());
app.use(cors());

// ========================= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ========================= //

// Рекурсивно получаем все дочерние подразделения (для include_subordinates=true)
async function getAllDeptIds(departmentId) {
    const sql = `
        WITH RECURSIVE subdeps AS (
            SELECT department_id
            FROM department
            WHERE department_id = $1
            UNION
            SELECT d.department_id
            FROM department d
                     JOIN subdeps s ON s.department_id = d.parent_id
        )
        SELECT department_id FROM subdeps
    `;
    const result = await pool.query(sql, [departmentId]);
    return result.rows.map(r => r.department_id);
}

// Проверка пересечений дат событий
// Мы всё ещё хотим сравнивать логическими строковыми значениями ("отпуск"/"отгул"/"обучение")
// Но в таблице employee_events хранится event_type_id → event_type_name.
// Значит, чтобы проверить уже существующие события, нужно JOIN event_type.
async function checkDateOverlaps(employeeId, newEvent) {
    // newEvent = { event_type: 'отгул' / 'отпуск' / 'обучение', date_start, date_end }
    const { event_type, date_start, date_end } = newEvent;

    const ds = new Date(date_start);
    const de = new Date(date_end);

    // Выберем все события, которые пересекаются по датам:
    const sql = `
    SELECT e.event_id,
           t.event_type_name AS existing_type,
           e.date_start,
           e.date_end
      FROM employee_events e
           JOIN event_type t ON t.event_type_id = e.event_type_id
     WHERE e.employee_id = $1
       AND e.date_end >= $2
       AND e.date_start <= $3
  `;
    const rows = (await pool.query(sql, [employeeId, ds, de])).rows;

    // Логика:
    // 1) отпуск НЕ пересек. с отгулом
    // 2) отгул НЕ пересек. с отпуском И обучением
    // 3) обучение НЕ пересек. с отгулом
    // 4) отпуск + обучение можно пересекать
    for (let ev of rows) {
        const existing = ev.existing_type;
        if (event_type === 'отпуск' && existing === 'отгул') {
            return 'Нельзя пересекать отпуск и отгул по датам';
        }
        if (event_type === 'отгул' && (existing === 'отпуск' || existing === 'обучение')) {
            return 'Отгул не может пересекаться с отпуском или обучением';
        }
        if (event_type === 'обучение' && existing === 'отгул') {
            return 'Обучение не может пересекаться с отгулом';
        }

        // Симметрично: если newEvent=отгул, existing=отпуск => конфликт
        // но это мы уже учли, логика покрывает.
    }

    return null; // нет конфликтов
}

// Проверяем производственный календарь (для "отгул")
async function checkWorkingCalendarIfOtgul(newEvent) {
    const { event_type, date_start, date_end } = newEvent;
    if (event_type !== 'отгул') {
        return null;
    }
    // Проверим все дни внутри диапазона
    const ds = new Date(date_start);
    const de = new Date(date_end);

    let day = new Date(ds);
    while (day <= de) {
        const sql = `
      SELECT isworkingday 
        FROM workingcalendar
       WHERE exceptiondate = $1
    `;
        const dateStr = day.toISOString().split('T')[0];
        const res = await pool.query(sql, [dateStr]);
        // Если rowCount=0 => считаем, что это обычный рабочий день
        if (res.rowCount > 0) {
            const row = res.rows[0];
            if (row.isworkingday === false) {
                return `Отгул не может быть в выходной (${dateStr})`;
            }
        }
        day.setDate(day.getDate()+1);
    }

    return null;
}

// ========================= ЭНДПОИНТЫ ========================= //

// 1) Получить список подразделений
app.get('/api/v1/departments', async (req, res) => {
    try {
        const sql = `
            SELECT department_id, parent_id, department_name
            FROM department
            ORDER BY department_id
        `;
        const result = await pool.query(sql);
        return res.json(result.rows);
    } catch (err) {
        console.error('Ошибка get departments:', err);
        return res.status(500).json({ message:'Ошибка при получении подразделений' });
    }
});

// 2) Получить сотрудников (с include_subordinates)
app.get('/api/v1/employees', async (req, res) => {
    try {
        const { department_id, include_subordinates } = req.query;
        const depId = parseInt(department_id, 10);
        if (isNaN(depId)) {
            return res.status(400).json({ message:'department_id невалиден' });
        }

        let depIds = [depId];
        if (include_subordinates==='true') {
            depIds = await getAllDeptIds(depId);
        }

        const sql = `
            SELECT e.employee_id,
                   e.last_name,
                   e.first_name,
                   e.middle_name,
                   p.position_name,
                   e.work_phone,
                   e.cabinet,
                   e.corporate_email,
                   e.department_id,
                   d.department_name,
                   e.date_end_work
            FROM employee e
                     JOIN department d ON d.department_id = e.department_id
                     JOIN position p   ON p.position_id   = e.position_id
            WHERE e.department_id = ANY($1)
            ORDER BY e.last_name, e.first_name
        `;
        const result = await pool.query(sql, [depIds]);

        // Уволенных >30 дней назад не показываем
        const now = new Date();
        const finalRows = result.rows.filter(row => {
            if (!row.date_end_work) return true; // не уволен
            const end = new Date(row.date_end_work);
            const diff = (now - end)/(1000*3600*24);
            return (diff <= 30);
        });

        return res.json(finalRows);
    } catch (err) {
        console.error('Ошибка get employees:', err);
        return res.status(500).json({ message:'Ошибка при получении сотрудников' });
    }
});

// 3) Получить детальную инфу о сотруднике + его события
app.get('/api/v1/employee/:id', async (req, res) => {
    const empId = parseInt(req.params.id, 10);
    if (isNaN(empId)) {
        return res.status(400).json({ message:'Неверный id' });
    }
    try {
        // Сотрудник
        const sqlEmp=`
            SELECT e.*, d.department_name, p.position_name
            FROM employee e
                     JOIN department d ON d.department_id = e.department_id
                     JOIN position p   ON p.position_id = e.position_id
            WHERE e.employee_id=$1
        `;
        const eRes = await pool.query(sqlEmp, [empId]);
        if (eRes.rowCount===0) {
            return res.status(404).json({ message:'Сотрудник не найден' });
        }
        const emp = eRes.rows[0];

        // События: JOIN с event_type
        const sqlEvt=`
            SELECT ev.event_id,
                   t.event_type_name AS event_type,
                   ev.date_start,
                   ev.date_end,
                   ev.reason
            FROM employee_events ev
                     JOIN event_type t ON t.event_type_id = ev.event_type_id
            WHERE ev.employee_id=$1
            ORDER BY ev.date_start
        `;
        const evRes = await pool.query(sqlEvt, [empId]);

        return res.json({
            employee: emp,
            events: evRes.rows
        });
    } catch (err) {
        console.error('Ошибка get employee:', err);
        return res.status(500).json({ message:'Ошибка при получении сотрудника' });
    }
});

// 4) Добавить нового сотрудника
app.post('/api/v1/employee', async (req, res) => {
    const {
        last_name, first_name, middle_name,
        date_of_birth, mobile_phone, work_phone,
        corporate_email, cabinet, department_id,
        position_id, manager_id, assistant_id,
        additional_info
    }=req.body;

    // Валидации
    if (!last_name || !first_name || !work_phone || !corporate_email
        || !cabinet || !department_id || !position_id) {
        return res.status(400).json({message:'Обязательные поля не заполнены'});
    }
    if (work_phone.length>20 || (mobile_phone && mobile_phone.length>20)) {
        return res.status(400).json({message:'Телефон не может превышать 20 символов'});
    }
    if (cabinet.length>10) {
        return res.status(400).json({message:'Кабинет не может превышать 10 символов'});
    }
    const emailRegex=/^.+@.+\..+$/;
    if (!emailRegex.test(corporate_email)) {
        return res.status(400).json({message:'Невалидный email'});
    }

    try {
        const sql=`
            INSERT INTO employee(
                last_name, first_name, middle_name,
                date_of_birth, mobile_phone, work_phone,
                corporate_email, cabinet, department_id,
                position_id, manager_id, assistant_id,
                additional_info
            )
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            RETURNING employee_id
        `;
        const vals = [
            last_name, first_name, middle_name||null,
            date_of_birth||null, mobile_phone||null, work_phone,
            corporate_email, cabinet, department_id,
            position_id, manager_id||null, assistant_id||null,
            additional_info||null
        ];
        const ins = await pool.query(sql, vals);
        return res.json({employee_id: ins.rows[0].employee_id});
    } catch (err) {
        console.error('Ошибка post employee:', err);
        return res.status(500).json({message:'Ошибка при добавлении сотрудника'});
    }
});

// 5) Обновить сотрудника
app.put('/api/v1/employee/:id', async (req, res) => {
    const empId = parseInt(req.params.id,10);
    if (isNaN(empId)) {
        return res.status(400).json({message:'Неверный id'});
    }
    const {
        last_name, first_name, middle_name,
        date_of_birth, mobile_phone, work_phone,
        corporate_email, cabinet, department_id,
        position_id, manager_id, assistant_id,
        additional_info
    } = req.body;

    if (!last_name || !first_name || !work_phone || !corporate_email
        || !cabinet || !department_id || !position_id) {
        return res.status(400).json({message:'Обязательные поля не заполнены'});
    }
    if (work_phone.length>20 || (mobile_phone && mobile_phone.length>20)) {
        return res.status(400).json({message:'Телефон не может превышать 20 символов'});
    }
    if (cabinet.length>10) {
        return res.status(400).json({message:'Кабинет не может превышать 10 символов'});
    }
    const emailRegex=/^.+@.+\..+$/;
    if (!emailRegex.test(corporate_email)) {
        return res.status(400).json({message:'Невалидный email'});
    }

    try {
        const sql=`
            UPDATE employee
            SET last_name=$1, first_name=$2, middle_name=$3,
                date_of_birth=$4, mobile_phone=$5, work_phone=$6,
                corporate_email=$7, cabinet=$8, department_id=$9,
                position_id=$10, manager_id=$11, assistant_id=$12,
                additional_info=$13
            WHERE employee_id=$14
        `;
        const vals = [
            last_name, first_name, middle_name||null,
            date_of_birth||null, mobile_phone||null, work_phone,
            corporate_email, cabinet, department_id,
            position_id, manager_id||null, assistant_id||null,
            additional_info||null, empId
        ];
        await pool.query(sql, vals);
        return res.json({message:'OK'});
    } catch (err) {
        console.error('Ошибка put employee:', err);
        return res.status(500).json({message:'Ошибка при обновлении сотрудника'});
    }
});

// 6) Получить список событий сотрудника
app.get('/api/v1/employee/:id/events', async (req, res) => {
    const empId = parseInt(req.params.id, 10);
    if (isNaN(empId)) {
        return res.status(400).json({message:'Неверный id'});
    }
    try {
        // JOIN с event_type, чтобы вернуть event_type_name
        const sql=`
            SELECT e.event_id,
                   t.event_type_name AS event_type,
                   e.date_start,
                   e.date_end,
                   e.reason
            FROM employee_events e
                     JOIN event_type t ON t.event_type_id = e.event_type_id
            WHERE e.employee_id=$1
            ORDER BY e.date_start
        `;
        const r = await pool.query(sql,[empId]);
        return res.json(r.rows);
    } catch(err){
        console.error('Ошибка get events:', err);
        return res.status(500).json({message:'Ошибка при получении событий'});
    }
});

// 7) Добавить событие
app.post('/api/v1/employee/:id/events', async (req,res)=>{
    const empId = parseInt(req.params.id,10);
    if (isNaN(empId)) {
        return res.status(400).json({message:'Неверный id сотрудника'});
    }
    const { event_type, date_start, date_end, reason } = req.body;

    if (!event_type || !date_start || !date_end) {
        return res.status(400).json({message:'Отсутствуют обязательные поля события'});
    }

    try {
        // 1) Найдём event_type_id по названию
        const typeSql = `SELECT event_type_id FROM event_type WHERE event_type_name=$1`;
        const typeRes = await pool.query(typeSql, [event_type]);
        if (typeRes.rowCount===0) {
            return res.status(400).json({message:`Неизвестный тип события: ${event_type}`});
        }
        const eventTypeId = typeRes.rows[0].event_type_id;

        // 2) Проверка пересечений
        const overlapErr = await checkDateOverlaps(empId, { event_type, date_start, date_end });
        if (overlapErr) {
            return res.status(400).json({ message: overlapErr });
        }

        // 3) Проверка рабочего календаря (только если отгул)
        const calErr = await checkWorkingCalendarIfOtgul({ event_type, date_start, date_end });
        if (calErr) {
            return res.status(400).json({ message: calErr });
        }

        // 4) Вставка
        const sql=`
            INSERT INTO employee_events
                (employee_id, event_type_id, date_start, date_end, reason)
            VALUES($1,$2,$3,$4,$5)
            RETURNING event_id
        `;
        const ins = await pool.query(sql,[empId, eventTypeId, date_start, date_end, reason||'']);
        return res.json({event_id:ins.rows[0].event_id});
    } catch(err) {
        console.error('Ошибка post event:', err);
        return res.status(500).json({message:'Ошибка при добавлении события'});
    }
});

// 8) Увольнение
app.delete('/api/v1/employee/:id', async (req,res)=>{
    const empId=parseInt(req.params.id,10);
    if (isNaN(empId)) {
        return res.status(400).json({message:'Неверный id сотрудника'});
    }
    try {
        // Проверяем будущие "обучения"
        // Т.к. event_type_id, JOIN event_type
        const sqlCheck=`
            SELECT e.event_id
            FROM employee_events e
                     JOIN event_type t ON t.event_type_id = e.event_type_id
            WHERE e.employee_id=$1
              AND t.event_type_name='обучение'
              AND e.date_start>current_date
        `;
        const c=await pool.query(sqlCheck,[empId]);
        if (c.rowCount>0){
            return res.status(400).json({message:'Нельзя уволить: есть будущие обучения'});
        }

        // Удаляем будущие отгулы/отпуска
        // Снова JOIN, чтобы найти event_type_name='отгул' или 'отпуск'
        // Но для удаления JOIN непрямолинейный. Лучше subselect:
        // event_type_id IN (SELECT event_type_id FROM event_type WHERE name in ...)
        const sqlDel=`
            DELETE FROM employee_events
            WHERE employee_id=$1
              AND date_start>current_date
              AND event_type_id IN (
                SELECT event_type_id
                FROM event_type
                WHERE event_type_name IN ('отпуск','отгул')
            )
        `;
        await pool.query(sqlDel,[empId]);

        // Ставим дату окончания работы
        const sqlUpd=`
            UPDATE employee
            SET date_end_work = current_date
            WHERE employee_id=$1
        `;
        await pool.query(sqlUpd,[empId]);

        return res.json({message:'Сотрудник уволен'});
    } catch(err){
        console.error('Ошибка увольнения:', err);
        return res.status(500).json({message:'Ошибка при увольнении'});
    }
});

// Запуск
app.listen(3000, ()=>{
    console.log('Server running on http://localhost:3000');
});