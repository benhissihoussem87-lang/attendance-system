import { byId, text } from './renderHelpers.js';

export const storage = { companyId: 'productOps.companyId' };
export const knownAgentId = 'ddc32a87-0b42-4448-bdcd-297642c66ee6';

export const state = {
  auth: {
    user: null,
    role: '',
    companyId: '',
    loaded: false,
    sessionExpired: false
  },
  companies: [],
  sites: [],
  agents: [],
  devices: [],
  siteActiveAgents: {},
  deviceReadiness: {},
  settingsErrors: {
    agents: '',
    siteAgents: '',
    deviceReadiness: ''
  },
  selectedDeviceUid: '',
  selectedSiteId: '',
  selectedDevice: null,
  selectedDeviceMonitoringSession: null,
  selectedDeviceRtRows: [],
  selectedDeviceSyncState: null,
  selectedDeviceTechnicalDetails: {
    evidence: '',
    monitoring: '',
    sync: ''
  },
  selectedDeviceLiveProof: false,
  latestCommand: null,
  latestBatch: null,
  latestSync: null,
  sse: null,
  currentModule: 'operations',
  operationsErrors: {
    sites: '',
    devices: '',
    evidence: '',
    realtime: '',
    monitoring: '',
    sync: ''
  },
  employees: [],
  selectedEmployeePersonId: '',
  selectedEmployee: null,
  employeeMappings: [],
  employeesError: '',
  attendance: {
    rows: [],
    unmappedDeviceUsers: [],
    meta: null,
    error: '',
    loading: false
  }
};

export function activeCompanyId() {
  if (state.auth && state.auth.companyId) {
    return state.auth.companyId;
  }
  return text(byId('companySelect').value || localStorage.getItem(storage.companyId) || 'DEFAULT').trim() || 'DEFAULT';
}
