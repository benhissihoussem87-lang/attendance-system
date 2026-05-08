import { request } from './apiClient.js';
import { activeCompanyId, state } from './state.js';
import { hasRole, renderAuthState } from './auth.js';
import { byId, esc, rows, setStatus, text } from './renderHelpers.js';
import { siteDisplayName } from './policies.js';

function metadata(employee) {
  return employee && employee.metadata && typeof employee.metadata === 'object' ? employee.metadata : {};
}

function employeeSiteLabel(employee) {
  const siteId = text(employee && (employee.site_id || metadata(employee).site_id)).trim();
  if (!siteId) return '-';
  const site = state.sites.find(row => text(row.site_id).trim() === siteId);
  return site ? siteDisplayName(site) : siteId;
}

function mappingSummary(employee) {
  const mappings = Array.isArray(employee && employee.device_mappings) ? employee.device_mappings : [];
  const active = mappings.filter(row => row.active !== false);
  if (!active.length) return '-';
  return active.map(row => (row.provider || '-') + ':' + (row.identifier_value || '-')).join(', ');
}

function selectedEmployeeMappings() {
  if (state.employeeMappings && state.employeeMappings.length) return state.employeeMappings;
  return Array.isArray(state.selectedEmployee && state.selectedEmployee.device_mappings)
    ? state.selectedEmployee.device_mappings
    : [];
}

function siteOptions(selectedSiteId = '') {
  const options = ['<option value="">No site</option>'];
  state.sites.forEach(site => {
    const siteId = text(site.site_id).trim();
    options.push('<option value="' + esc(siteId) + '"' + (siteId === selectedSiteId ? ' selected' : '') + '>'
      + esc(siteDisplayName(site)) + '</option>');
  });
  return options.join('');
}

function setFormDisabled(disabled) {
  ['employeeCodeInput', 'employeeFirstNameInput', 'employeeLastNameInput', 'employeeFullNameInput', 'employeeSiteInput', 'employeeJobInput', 'employeeNotesInput', 'employeeActiveInput', 'mappingProviderInput', 'mappingDeviceUserInput', 'mappingActiveInput'].forEach(id => {
    const element = byId(id);
    if (element) element.disabled = disabled;
  });
  const saveEmployee = byId('saveEmployeeButton');
  const saveMapping = byId('saveMappingButton');
  if (saveEmployee) saveEmployee.hidden = disabled;
  if (saveMapping) saveMapping.hidden = disabled;
}

function fillEmployeeForm(employee) {
  const meta = metadata(employee);
  byId('employeeCodeInput').value = employee ? text(employee.employee_code) : '';
  byId('employeeFirstNameInput').value = employee ? text(employee.first_name || meta.first_name) : '';
  byId('employeeLastNameInput').value = employee ? text(employee.last_name || meta.last_name) : '';
  byId('employeeFullNameInput').value = employee ? text(employee.full_name) : '';
  byId('employeeSiteInput').innerHTML = siteOptions(employee ? text(employee.site_id || meta.site_id) : '');
  byId('employeeJobInput').value = employee ? text(employee.job_title || meta.job_title || meta.poste) : '';
  byId('employeeNotesInput').value = employee ? text(employee.notes || meta.notes) : '';
  byId('employeeActiveInput').value = !employee || employee.active !== false ? 'true' : 'false';
  byId('mappingProviderInput').value = 'zkteco';
  byId('mappingDeviceUserInput').value = '';
  byId('mappingActiveInput').value = 'true';
}

export function renderEmployees() {
  const body = byId('employeesBody');
  if (!body) return;
  const canEdit = hasRole('admin');
  const stateLine = byId('employeesState');
  const error = state.employeesError;
  if (stateLine) {
    stateLine.textContent = error || (state.employees.length ? 'Employees loaded for ' + activeCompanyId() + '.' : 'No employees found for ' + activeCompanyId() + '.');
  }
  if (!state.employees.length) {
    body.innerHTML = '<tr><td colspan="5">' + esc(error || 'No employees loaded.') + '</td></tr>';
  } else {
    body.innerHTML = state.employees.map(employee => {
      const selected = employee.person_id === state.selectedEmployeePersonId;
      return '<tr data-person-id="' + esc(employee.person_id) + '"' + (selected ? ' class="selected"' : '') + '>'
        + '<td>' + esc(employee.employee_code || '-') + '</td>'
        + '<td><button type="button" class="link-button" data-select-employee="' + esc(employee.person_id) + '">' + esc(employee.full_name || employee.person_id) + '</button></td>'
        + '<td>' + esc(employee.active === false ? 'inactive' : 'active') + '</td>'
        + '<td>' + esc(employeeSiteLabel(employee)) + '</td>'
        + '<td>' + esc(mappingSummary(employee)) + '</td>'
        + '</tr>';
    }).join('');
  }
  renderSelectedEmployee();
  renderAuthState();
  setFormDisabled(!canEdit);
}

export function renderSelectedEmployee() {
  const employee = state.selectedEmployee;
  const title = byId('selectedEmployeeTitle');
  if (title) title.textContent = employee ? (employee.full_name || employee.person_id) : 'New employee';
  fillEmployeeForm(employee);
  renderMappings();
}

function renderMappings() {
  const target = byId('employeeMappingsList');
  if (!target) return;
  if (!state.selectedEmployee) {
    target.textContent = 'Select or create an employee before mapping a device user id.';
    return;
  }
  const mappings = selectedEmployeeMappings();
  if (!mappings.length) {
    target.textContent = 'No device user mapping for this employee.';
    return;
  }
  target.innerHTML = '<dl>' + mappings.map(row => '<dt>' + esc(row.provider || '-') + ' / ' + esc(row.identifier_type || '-') + '</dt><dd>'
    + esc(row.identifier_value || '-') + ' ? person ' + esc(row.person_id || '-') + ' ? ' + esc(row.active === false ? 'inactive' : 'active')
    + '</dd>').join('') + '</dl>';
}

export async function loadEmployees() {
  try {
    state.employeesError = '';
    const data = await request('GET', '/api/employee-management/employees', undefined, { company_id: activeCompanyId(), limit: 500 });
    state.employees = rows(data);
    if (state.selectedEmployeePersonId && !state.employees.some(row => row.person_id === state.selectedEmployeePersonId)) {
      state.selectedEmployeePersonId = '';
      state.selectedEmployee = null;
      state.employeeMappings = [];
    }
    if (!state.selectedEmployeePersonId && state.employees[0]) {
      state.selectedEmployeePersonId = state.employees[0].person_id;
    }
    state.selectedEmployee = state.employees.find(row => row.person_id === state.selectedEmployeePersonId) || null;
    state.employeeMappings = selectedEmployeeMappings();
  } catch (err) {
    state.employees = [];
    state.selectedEmployee = null;
    state.employeeMappings = [];
    state.employeesError = err && err.message ? err.message : 'Employees unavailable';
  }
  renderEmployees();
}

export async function selectEmployee(personId) {
  state.selectedEmployeePersonId = personId || '';
  if (!state.selectedEmployeePersonId) {
    state.selectedEmployee = null;
    state.employeeMappings = [];
    renderEmployees();
    return;
  }
  const data = await request('GET', '/api/employee-management/employees/' + encodeURIComponent(state.selectedEmployeePersonId), undefined, { company_id: activeCompanyId() });
  state.selectedEmployee = data;
  state.employeeMappings = Array.isArray(data.device_mappings) ? data.device_mappings : [];
  const index = state.employees.findIndex(row => row.person_id === state.selectedEmployeePersonId);
  if (index >= 0) state.employees[index] = data;
  renderEmployees();
}

function employeePayloadFromForm() {
  const firstName = text(byId('employeeFirstNameInput').value).trim();
  const lastName = text(byId('employeeLastNameInput').value).trim();
  const fullName = text(byId('employeeFullNameInput').value).trim() || [firstName, lastName].filter(Boolean).join(' ');
  return {
    company_id: activeCompanyId(),
    employee_code: text(byId('employeeCodeInput').value).trim(),
    first_name: firstName,
    last_name: lastName,
    full_name: fullName,
    site_id: text(byId('employeeSiteInput').value).trim(),
    job_title: text(byId('employeeJobInput').value).trim(),
    notes: text(byId('employeeNotesInput').value).trim(),
    active: byId('employeeActiveInput').value !== 'false'
  };
}

async function saveEmployee(event) {
  event.preventDefault();
  if (!hasRole('admin')) throw new Error('insufficient_role');
  const payload = employeePayloadFromForm();
  if (!payload.employee_code) throw new Error('Matricule is required');
  if (!payload.full_name) throw new Error('Employee name is required');
  const saved = state.selectedEmployee && state.selectedEmployee.person_id
    ? await request('PATCH', '/api/employee-management/employees/' + encodeURIComponent(state.selectedEmployee.person_id), payload)
    : await request('POST', '/api/employee-management/employees', payload);
  state.selectedEmployeePersonId = saved.person_id;
  await loadEmployees();
  await selectEmployee(saved.person_id);
  setStatus('Employee saved.');
}

async function saveMapping(event) {
  event.preventDefault();
  if (!hasRole('admin')) throw new Error('insufficient_role');
  if (!state.selectedEmployee || !state.selectedEmployee.person_id) throw new Error('Select an employee first');
  const body = {
    company_id: activeCompanyId(),
    provider: text(byId('mappingProviderInput').value).trim() || 'zkteco',
    identifier_type: 'device_user_id',
    identifier_value: text(byId('mappingDeviceUserInput').value).trim(),
    active: byId('mappingActiveInput').value !== 'false',
    metadata: { source: 'product_app_employees_v1' }
  };
  if (!body.identifier_value) throw new Error('Device user ID is required');
  await request('PUT', '/api/employee-management/employees/' + encodeURIComponent(state.selectedEmployee.person_id) + '/device-mappings', body);
  await selectEmployee(state.selectedEmployee.person_id);
  setStatus('Device user mapping saved.');
}

function startNewEmployee() {
  state.selectedEmployeePersonId = '';
  state.selectedEmployee = null;
  state.employeeMappings = [];
  renderEmployees();
  const codeInput = byId('employeeCodeInput');
  if (codeInput && !codeInput.disabled) codeInput.focus();
}

export function bindEmployees() {
  const body = byId('employeesBody');
  if (body) {
    body.addEventListener('click', event => {
      const button = event.target.closest('[data-select-employee]');
      if (!button) return;
      selectEmployee(button.getAttribute('data-select-employee')).catch(err => setStatus('Employee load failed: ' + err.message));
    });
  }
  const form = byId('employeeForm');
  if (form) form.addEventListener('submit', event => saveEmployee(event).catch(err => setStatus('Employee save failed: ' + err.message)));
  const mappingForm = byId('employeeMappingForm');
  if (mappingForm) mappingForm.addEventListener('submit', event => saveMapping(event).catch(err => setStatus('Mapping save failed: ' + err.message)));
  const newButton = byId('newEmployeeButton');
  if (newButton) newButton.addEventListener('click', startNewEmployee);
  const refreshButton = byId('refreshEmployeesButton');
  if (refreshButton) refreshButton.addEventListener('click', () => loadEmployees().catch(err => setStatus('Employee refresh failed: ' + err.message)));
}
