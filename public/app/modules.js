import { state } from './state.js';
import { byId } from './renderHelpers.js';
import { closeSse, openSse } from './realtime.js';
import { hasRole } from './auth.js';

export function setCurrentModule(moduleName) {
  if (moduleName === 'settings' && !hasRole('admin')) {
    moduleName = 'operations';
  }
  state.currentModule = moduleName || 'operations';
  document.querySelectorAll('[data-module-panel]').forEach(panel => {
    panel.hidden = panel.getAttribute('data-module-panel') !== state.currentModule;
  });
  document.querySelectorAll('[data-module]').forEach(button => {
    button.classList.toggle('selected', button.getAttribute('data-module') === state.currentModule);
  });
  byId('operationsNavigator').hidden = state.currentModule !== 'operations';
  if (state.currentModule !== 'operations') closeSse('Live connection paused outside Operations.');
  if (state.currentModule === 'operations' && state.selectedDevice) openSse();
}

export function bindModuleNavigation() {
  document.querySelectorAll('[data-module]').forEach(button => {
    button.addEventListener('click', () => setCurrentModule(button.getAttribute('data-module')));
  });
}
