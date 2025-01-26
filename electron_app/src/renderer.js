// ==== Глобальные переменные ====
const API_URL = 'http://localhost:3000/api/v1';

let departments = [];
let employees = [];

const svgContainer = document.getElementById('svgContainer');
const svgOrg = document.getElementById('svgOrg');
const employeesList = document.getElementById('employeesList');
const modalOverlay = document.getElementById('modalOverlay');
const cardContent = document.getElementById('cardContent');
const closeModalBtn = document.getElementById('closeModal');

closeModalBtn.addEventListener('click', () => {
    modalOverlay.classList.add('hidden');
});

function initApp() {
    loadDepartments();
    modalOverlay.classList.add('hidden');
}
initApp();

// ================== ЗАГРУЗКА ОРГСТРУКТУРЫ ==================
async function loadDepartments() {
    try {
        const resp = await axios.get(`${API_URL}/departments`);
        departments = resp.data;
        drawOrgDagre();
    } catch(e) {
        console.error(e);
        alert('Ошибка при загрузке структуры');
    }
}

function drawOrgDagre() {
    // Создаём граф
    const g = new dagreD3.graphlib.Graph()
        .setGraph({
            rankdir: 'TB', // или 'LR'
            ranksep: 100,  // побольше расстояние по вертикали
            nodesep: 40,   // расстояние между узлами
            edgesep: 10,
            marginx: 20,
            marginy: 20
        })
        .setDefaultEdgeLabel(() => ({}));

    // Добавляем узлы. Используем labelType:'html'
    for (const dep of departments) {
        g.setNode(dep.department_id, {
            labelType: 'html',
            label: `<div style="width:200px; word-wrap:break-word;">${dep.department_name}</div>`,
            class: 'depNode'
        });
    }

    // Добавляем рёбра
    for (const dep of departments) {
        if (dep.parent_id) {
            g.setEdge(dep.parent_id, dep.department_id, { arrowhead: 'normal' });
        }
    }

    // Очищаем <svg>
    const d3svg = d3.select('#svgOrg');
    d3svg.selectAll('*').remove();

    const inner = d3svg.append('g');
    const render = new dagreD3.render();

    // Рендерим граф
    render(inner, g);

    // Получаем итоговые размеры
    const { width, height } = g.graph();
    // Ставим svg чуть больше
    d3svg.attr('width', width + 50);
    d3svg.attr('height', height + 50);

    // Навешиваем клики
    inner.selectAll('g.node')
        .on('click', (event, nodeId) => {
            loadEmployees(nodeId);
        });
}

// ================== ЗАГРУЗКА СПИСКА СОТРУДНИКОВ ==================
async function loadEmployees(departmentId) {
    try {
        const url = `${API_URL}/employees?department_id=${departmentId}&include_subordinates=true`;
        const resp = await axios.get(url);
        employees = resp.data;
        renderEmployeesList();
    } catch(e){
        console.error(e);
        alert('Ошибка при загрузке сотрудников');
    }
}

function renderEmployeesList() {
    employeesList.innerHTML = '';
    for (const emp of employees) {
        // Если уволен >30дней назад, не отображаем
        if(emp.date_end_work) {
            const end = new Date(emp.date_end_work);
            const diff = (new Date()-end)/(1000*3600*24);
            if(diff>30) continue;
        }

        const row = document.createElement('div');
        row.className = 'employeeRow';

        // Если уволен <=30дн, делаем серым
        if(emp.date_end_work) {
            const end = new Date(emp.date_end_work);
            const diff = (new Date()-end)/(1000*3600*24);
            if(diff>=0 && diff<=30) {
                row.classList.add('fired30');
            }
        }

        const fullName = `${emp.last_name} ${emp.first_name} ${emp.middle_name||''}`.trim();
        row.innerHTML = `
      <div><b>${fullName}</b> (${emp.position_name})</div>
      <div>${emp.department_name} | ${emp.work_phone} | ${emp.cabinet} | ${emp.corporate_email}</div>
    `;
        row.addEventListener('click', ()=> openEmployeeCard(emp.employee_id));
        employeesList.appendChild(row);
    }
}

// ================== КАРТОЧКА СОТРУДНИКА ==================
async function openEmployeeCard(employeeId) {
    try {
        const resp = await axios.get(`${API_URL}/employee/${employeeId}`);
        const emp = resp.data.employee;
        const events = resp.data.events;
        cardContent.innerHTML = buildEmployeeCardHtml(emp, events);
        initEmployeeCardLogic(emp);
        modalOverlay.classList.remove('hidden');
    } catch(e){
        console.error(e);
        alert('Ошибка при загрузке карточки');
    }
}

function buildEmployeeCardHtml(emp, events) {
    const sorted = events.slice().sort((a,b)=> new Date(a.date_start)- new Date(b.date_start));
    const fullName = `${emp.last_name} ${emp.first_name} ${emp.middle_name||''}`.trim();
    return `
  <h3>Карточка сотрудника</h3>
  <div id="empStaticView">
    <p>ФИО: ${fullName}</p>
    <p>Тел(раб): ${emp.work_phone}, моб: ${emp.mobile_phone||''}</p>
    <p>Email: ${emp.corporate_email}</p>
    <p>Кабинет: ${emp.cabinet}</p>
    <p>Подразделение: ${emp.department_name}</p>
    <p>Должность: ${emp.position_name}</p>
    <button id="editBtn">✎ Редактировать</button>
    <button id="fireBtn">Уволить</button>
  </div>

  <div id="empEditView" class="hidden">
    <label>Фамилия <input id="editLastName" value="${emp.last_name}"></label><br>
    <label>Имя <input id="editFirstName" value="${emp.first_name}"></label><br>
    <label>Отчество <input id="editMiddleName" value="${emp.middle_name||''}"></label><br>
    <label>Тел(раб) <input id="editWorkPhone" value="${emp.work_phone}"></label><br>
    <label>Тел(моб) <input id="editMobile" value="${emp.mobile_phone||''}"></label><br>
    <label>Email <input id="editEmail" value="${emp.corporate_email}"></label><br>
    <label>Кабинет <input id="editCabinet" value="${emp.cabinet}"></label><br>
    <button id="saveChanges">Сохранить</button>
    <button id="cancelEdit">Отмена</button>
  </div>

  <hr>
  <h4>Список событий</h4>
  <div>
    ${sorted.map(ev=>{
        return `<div><b>${ev.event_type}</b>: ${ev.date_start} - ${ev.date_end} [${ev.reason||''}]</div>`;
    }).join('')}
  </div>
  <button id="addEventBtn">Добавить событие</button>
  <div id="addEventArea" class="hidden">
    <select id="eventType">
      <option value="">(тип)</option>
      <option value="обучение">обучение</option>
      <option value="отпуск">отпуск</option>
      <option value="отгул">отгул</option>
    </select><br>
    <label>Дата начала <input type="date" id="evtStart"></label><br>
    <label>Дата конца <input type="date" id="evtEnd"></label><br>
    <label>Причина <input id="evtReason"></label><br>
    <button id="saveEventBtn">Сохранить</button>
    <button id="cancelEventBtn">Отмена</button>
  </div>
  `;
}

function initEmployeeCardLogic(emp) {
    const empStaticView = document.getElementById('empStaticView');
    const empEditView = document.getElementById('empEditView');
    const editBtn = document.getElementById('editBtn');
    const fireBtn = document.getElementById('fireBtn');
    const saveChanges = document.getElementById('saveChanges');
    const cancelEdit = document.getElementById('cancelEdit');

    editBtn.addEventListener('click', ()=>{
        empStaticView.classList.add('hidden');
        empEditView.classList.remove('hidden');
    });
    cancelEdit.addEventListener('click', ()=>{
        empEditView.classList.add('hidden');
        empStaticView.classList.remove('hidden');
    });

    saveChanges.addEventListener('click', async ()=>{
        const last_name = document.getElementById('editLastName').value.trim();
        const first_name = document.getElementById('editFirstName').value.trim();
        const middle_name = document.getElementById('editMiddleName').value.trim();
        const work_phone = document.getElementById('editWorkPhone').value.trim();
        const mobile_phone = document.getElementById('editMobile').value.trim();
        const corporate_email = document.getElementById('editEmail').value.trim();
        const cabinet = document.getElementById('editCabinet').value.trim();

        if(!last_name || !first_name || !work_phone || !corporate_email || !cabinet) {
            alert('Обязательные поля не заполнены');
            return;
        }
        if(work_phone.length>20 || mobile_phone.length>20) {
            alert('Телефон > 20 символов');
            return;
        }
        if(cabinet.length>10) {
            alert('Кабинет > 10 символов');
            return;
        }
        const emailRegex = /^.+@.+\..+$/;
        if(!emailRegex.test(corporate_email)) {
            alert('Неверный email');
            return;
        }

        try {
            await axios.put(`${API_URL}/employee/${emp.employee_id}`, {
                last_name, first_name, middle_name,
                work_phone, mobile_phone, corporate_email, cabinet,
                department_id: emp.department_id,
                position_id: emp.position_id,
                manager_id: emp.manager_id,
                assistant_id: emp.assistant_id
            });
            alert('Сохранено!');
            openEmployeeCard(emp.employee_id);
        } catch(e){
            console.error(e);
            alert(e.response?.data?.message||'Ошибка при сохранении');
        }
    });

    fireBtn.addEventListener('click', async()=>{
        if(!confirm('Уволить сотрудника?'))return;
        try {
            await axios.delete(`${API_URL}/employee/${emp.employee_id}`);
            alert('Сотрудник уволен');
            modalOverlay.classList.add('hidden');
        } catch(e){
            console.error(e);
            alert(e.response?.data?.message||'Ошибка при увольнении');
        }
    });

    // Добавить событие
    const addEventBtn = document.getElementById('addEventBtn');
    const addEventArea = document.getElementById('addEventArea');
    const saveEventBtn = document.getElementById('saveEventBtn');
    const cancelEventBtn = document.getElementById('cancelEventBtn');

    addEventBtn.addEventListener('click', ()=>{
        addEventArea.classList.remove('hidden');
    });
    cancelEventBtn.addEventListener('click', ()=>{
        addEventArea.classList.add('hidden');
    });

    saveEventBtn.addEventListener('click', async()=>{
        const etype = document.getElementById('eventType').value;
        const ds = document.getElementById('evtStart').value;
        const de = document.getElementById('evtEnd').value;
        const reason = document.getElementById('evtReason').value.trim();

        if(!etype || !ds || !de) {
            alert('Заполните обязательные поля');
            return;
        }
        if(new Date(de)<new Date(ds)) {
            alert('Дата окончания не может быть меньше даты начала');
            return;
        }

        try {
            await axios.post(`${API_URL}/employee/${emp.employee_id}/events`, {
                event_type: etype,
                date_start: ds,
                date_end: de,
                reason
            });
            alert('Событие добавлено!');
            openEmployeeCard(emp.employee_id);
        } catch(e){
            console.error(e);
            alert(e.response?.data?.message||'Ошибка при добавлении события');
        }
    });
}
