// ASKII setupPanel webview script — loaded by src via asWebviewUri.
const ASKII_DATA = JSON.parse(document.getElementById('askii-data').textContent);
const vscode = acquireVsCodeApi();
const state = ASKII_DATA.state;
const screens = { provider: document.getElementById('providerScreen'), models: document.getElementById('modelsScreen'), options: document.getElementById('optionsScreen'), wiki: document.getElementById('wikiScreen') };
const dots = Array.from(document.querySelectorAll('.dot'));
const stepIndex = { provider: 0, models: 1, options: 2, wiki: 3 };
let selectedProvider = state.provider;
let currentStep = state.step;

function showError(id, text) { const el = document.getElementById(id); el.textContent = text || ''; el.classList.toggle('show', Boolean(text)); }
function showStep(step) { currentStep = step; Object.entries(screens).forEach(([name, el]) => el.classList.toggle('active', name === step)); dots.forEach((dot, index) => dot.classList.toggle('active', index <= stepIndex[step])); window.scrollTo({ top: 0, behavior: 'smooth' }); }
function providerDefinition() { return state.providers.find((provider) => provider.id === selectedProvider); }
function selectProvider(provider) {
  selectedProvider = provider;
  document.querySelectorAll('.provider').forEach((card) => card.classList.toggle('selected', card.dataset.provider === provider));
  const definition = providerDefinition();
  document.getElementById('apiKeyField').hidden = definition.connection !== 'apiKey';
  document.getElementById('serverUrlField').hidden = definition.connection !== 'serverUrl';
  document.getElementById('openaiUrlField').hidden = !definition.supportsCustomBaseUrl;
  document.getElementById('savedCredential').textContent = state.savedCredentials[provider] ? '✓ saved' : '';
  document.getElementById('serverUrl').value = provider === 'ollama' ? state.urls.ollama : provider === 'lmstudio' ? state.urls.lmstudio : '';
  document.getElementById('openaiUrl').value = state.urls.openai;
  document.getElementById('apiKey').value = '';
  showError('providerError', '');
}
const providersHost = document.getElementById('providers');
state.providers.forEach((provider, index) => {
  const card = document.createElement('button'); card.type = 'button'; card.className = 'provider'; card.dataset.provider = provider.id; card.style.animationDelay = (index * 55) + 'ms';
  const title = document.createElement('strong'); title.textContent = provider.label; const description = document.createElement('span'); description.textContent = provider.description;
  card.append(title, description); card.addEventListener('click', () => selectProvider(provider.id)); providersHost.appendChild(card);
});

function buildModelControl(role, value) {
  const host = document.getElementById(role + 'ModelHost'); host.textContent = '';
  const control = document.createElement(state.manualModels ? 'input' : 'select'); control.id = role + 'Model'; control.dataset.role = role;
  if (state.manualModels) { control.type = 'text'; control.placeholder = 'Enter the exact model ID'; control.value = value || ''; }
  else { const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose a model…'; control.appendChild(placeholder); state.models.forEach((model) => { const option = document.createElement('option'); option.value = model; option.textContent = model; control.appendChild(option); }); control.value = value || ''; }
  host.appendChild(control);
}
function renderModels() {
  document.getElementById('modelLead').textContent = state.manualModels ? 'Enter the exact model ID for each ASKII role.' : state.models.length + ' models found for ' + providerDefinition().label + '.';
  const warning = document.getElementById('modelWarning'); warning.hidden = !state.modelWarning; warning.textContent = state.modelWarning;
  buildModelControl('general', state.selections.general); buildModelControl('inline', state.selections.inline); buildModelControl('vision', state.selections.vision);
}
document.getElementById('inlineCompletionEnabled').checked = state.options.inlineCompletionEnabled;
document.getElementById('inlineCompletionEagerness').value = state.options.inlineCompletionEagerness;
document.getElementById('inlineHelperMode').value = state.options.inlineHelperMode;
document.getElementById('formatAfterEdit').checked = state.options.formatAfterEdit;
document.getElementById('doAutoConfirm').checked = state.options.doAutoConfirm;
document.getElementById('wikiEnabled').checked = state.options.wikiEnabled;
document.getElementById('wikiPathInput').value = state.options.wikiPath;
document.getElementById('wikiAutoReload').checked = state.options.wikiAutoReload;
document.getElementById('codeWikiEnabled').checked = state.options.codeWikiEnabled;
document.getElementById('codeWikiAutoReload').checked = state.options.codeWikiAutoReload;
document.getElementById('chromePathInput').value = state.options.chromePath;
document.getElementById('commitRulesInput').value = state.options.commitMessageInstructions;

document.getElementById('providerNext').addEventListener('click', () => {
  const definition = providerDefinition(); const apiKey = document.getElementById('apiKey').value.trim(); const serverUrl = document.getElementById('serverUrl').value.trim();
  if (definition.connection === 'apiKey' && !apiKey && !state.savedCredentials[selectedProvider]) { showError('providerError', 'Enter an API key.'); return; }
  if (definition.connection === 'serverUrl' && !serverUrl) { showError('providerError', 'Enter a server URL.'); return; }
  showError('providerError', ''); document.getElementById('providerLoader').classList.add('show'); document.getElementById('providerNext').disabled = true;
  vscode.postMessage({ type: 'validateProvider', provider: selectedProvider, apiKey, serverUrl, openaiBaseUrl: document.getElementById('openaiUrl').value.trim() });
});
document.getElementById('modelsBack').addEventListener('click', () => showStep('provider'));
document.getElementById('modelsNext').addEventListener('click', () => {
  const values = { general: document.getElementById('generalModel').value.trim(), inline: document.getElementById('inlineModel').value.trim(), vision: document.getElementById('visionModel').value.trim() };
  if (!values.general || !values.inline || !values.vision) { showError('modelsError', 'Choose a model for all three roles.'); return; }
  state.selections = values; showError('modelsError', ''); document.getElementById('modelsNext').disabled = true; vscode.postMessage({ type: 'saveModels', provider: selectedProvider, ...values });
});
document.getElementById('optionsBack').addEventListener('click', () => showStep('models'));
document.getElementById('optionsNext').addEventListener('click', () => showStep('wiki'));
document.getElementById('wikiBack').addEventListener('click', () => showStep('options'));
function setFinalActions(disabled) { document.getElementById('optionsIgnore').disabled = disabled; document.getElementById('ignore').disabled = disabled; document.getElementById('finish').disabled = disabled; }
function requestIgnore() { setFinalActions(true); vscode.postMessage({ type: 'ignore' }); }
document.getElementById('optionsIgnore').addEventListener('click', requestIgnore);
document.getElementById('ignore').addEventListener('click', requestIgnore);
function wirePathPicker(inputId, buttonId, target) { document.getElementById(buttonId).addEventListener('click', () => vscode.postMessage({ type: 'pickPath', target, current: document.getElementById(inputId).value.trim() })); }
wirePathPicker('wikiPathInput', 'wikiPathBrowse', 'wikiPath');
wirePathPicker('chromePathInput', 'chromePathBrowse', 'chromePath');
wirePathPicker('commitRulesInput', 'commitRulesBrowse', 'commitMessageInstructions');
function finishPayload() { return { inlineCompletionEnabled: document.getElementById('inlineCompletionEnabled').checked, inlineCompletionEagerness: document.getElementById('inlineCompletionEagerness').value, inlineHelperMode: document.getElementById('inlineHelperMode').value, formatAfterEdit: document.getElementById('formatAfterEdit').checked, doAutoConfirm: document.getElementById('doAutoConfirm').checked, wikiEnabled: document.getElementById('wikiEnabled').checked, wikiPath: document.getElementById('wikiPathInput').value.trim(), wikiAutoReload: document.getElementById('wikiAutoReload').checked, codeWikiEnabled: document.getElementById('codeWikiEnabled').checked, codeWikiAutoReload: document.getElementById('codeWikiAutoReload').checked, chromePath: document.getElementById('chromePathInput').value.trim(), commitMessageInstructions: document.getElementById('commitRulesInput').value.trim() }; }
document.getElementById('finish').addEventListener('click', () => { setFinalActions(true); vscode.postMessage({ type: 'finish', ...finishPayload() }); });

window.addEventListener('message', (event) => {
  const message = event.data; if (!message || typeof message !== 'object') return;
  if (message.type === 'providerValidated') {
    document.getElementById('providerLoader').classList.remove('show'); document.getElementById('providerNext').disabled = false; document.getElementById('apiKey').value = '';
    state.savedCredentials[selectedProvider] = message.savedCredential || state.savedCredentials[selectedProvider]; state.models = message.models; state.manualModels = message.manual; state.modelWarning = message.warning; state.selections = message.selections; renderModels(); showStep('models');
  } else if (message.type === 'modelsSaved') { document.getElementById('modelsNext').disabled = false; showStep('options'); }
  else if (message.type === 'pathPicked') { const inputIds = { wikiPath: 'wikiPathInput', chromePath: 'chromePathInput', commitMessageInstructions: 'commitRulesInput' }; const input = document.getElementById(inputIds[message.target]); if (input && message.path) input.value = message.path; }
  else if (message.type === 'setupError') {
    if (message.operation === 'validateProvider') { document.getElementById('providerLoader').classList.remove('show'); document.getElementById('providerNext').disabled = false; showError('providerError', message.message); }
    else if (message.operation === 'saveModels') { document.getElementById('modelsNext').disabled = false; showError('modelsError', message.message); }
    else { setFinalActions(false); showError(currentStep === 'options' ? 'optionsError' : 'wikiError', message.message); }
  }
});
selectProvider(selectedProvider); renderModels(); showStep(currentStep);
