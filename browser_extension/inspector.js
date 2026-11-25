const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tabId'));
let requests = [];
let activeFilter = 'all';
let searchValue = '';
let timer = null;
let currentTab = null;
let refreshSequence = 0;
const expandedDomains = new Set();
const expandedRequestIds = new Set();
const replayDrafts = new Map();
const replayOpenIds = new Set();
const replayResults = new Map();
const pausedIntercepts = new Map();
const breakpointUrls = new Set();
const networkAllowedDomains = new Set();
let siteConsoleMessages = [];
let consoleCaptureEnabled = false;

function send(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, response => {
            const error = chrome.runtime.lastError;
            if (error) return reject(new Error(error.message));
            resolve(response || {});
        });
    });
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value ?? '');
}

function httpLabel(request) {
    const code = Number(request.httpStatus) || 0;
    if (!code) return request.networkState === 'pending' ? 'قيد الاتصال' : '—';
    return `HTTP ${code}${code === 200 ? ' OK' : ''}`;
}

function statusLabel(request) {
    if (request.status === 'blocked') return ['محظور', 'blocked'];
    if (request.status === 'error') return ['فشل الاتصال', 'error'];
    if (request.networkState === 'pending') return ['جارٍ الاتصال', 'pending'];
    return ['مسموح', 'allowed'];
}

async function refresh() {
    if (!Number.isInteger(tabId) || tabId <= 0) return;
    const sequence = ++refreshSequence;
    try {
        const result = await send({ action: 'getTabRequests', tabId });
        if (sequence !== refreshSequence) return;
        if (!result.success) throw new Error(result.error || 'تعذر قراءة سجل الشبكة.');
        requests = Array.isArray(result.requests) ? result.requests : [];
        const stats = result.stats || {};
        setText('total-count', stats.total || 0);
        setText('blocked-count', stats.blocked || 0);
        setText('allowed-count', stats.allowed || 0);
        setText('error-count', stats.errors || 0);
        setText('ok-count', stats.successful || 0);
        setText('updated-at', `آخر تحديث ${new Date().toLocaleTimeString()}`);
        render();
    } catch (error) {
        setText('scope', error.message || 'تعذر الاتصال بالإضافة.');
    }
}

async function refreshNetworkAllowlist() {
    try {
        const stored = await chrome.storage.local.get('adblock_network_allowlist');
        networkAllowedDomains.clear();
        (Array.isArray(stored.adblock_network_allowlist) ? stored.adblock_network_allowlist : [])
            .forEach(domain => networkAllowedDomains.add(String(domain).toLowerCase()));
    } catch (_) {}
}

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.adblock_network_allowlist) return;
    networkAllowedDomains.clear();
    (Array.isArray(changes.adblock_network_allowlist.newValue) ? changes.adblock_network_allowlist.newValue : [])
        .forEach(domain => networkAllowedDomains.add(String(domain).toLowerCase()));
    render();
});

function render() {
    const tbody = document.getElementById('requests');
    const filtered = requests.filter(request => {
        if (activeFilter === 'blocked' && request.status !== 'blocked') return false;
        if (activeFilter === 'allowed' && request.status === 'blocked') return false;
        if (activeFilter === 'errors' && request.status !== 'error' && Number(request.httpStatus) < 400) return false;
        if (activeFilter === 'thirdParty' && !request.isThirdParty) return false;
        if (searchValue && !`${request.domain} ${request.url} ${request.type}`.toLowerCase().includes(searchValue)) return false;
        return true;
    });

    tbody.replaceChildren();
    if (!filtered.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.className = 'empty';
        cell.colSpan = 8;
        cell.textContent = requests.length ? 'لا توجد طلبات مطابقة للبحث أو التصفية.' : 'لا توجد طلبات بعد. أعد تحميل الصفحة لتبدأ المراقبة من أول اتصال.';
        row.appendChild(cell);
        tbody.appendChild(row);
        return;
    }

    const groups = new Map();
    for (const request of filtered.slice(0, 1000)) {
        // Group only by the exact hostname. Paths share a group; subdomains
        // such as gemini.google.com remain separate from google.com.
        const domain = String(request.domain || 'غير معروف').toLowerCase();
        if (!groups.has(domain)) groups.set(domain, []);
        groups.get(domain).push(request);
    }

    const fragment = document.createDocumentFragment();
    for (const [domain, domainRequests] of groups) {
        const isExpanded = expandedDomains.has(domain);
        const blockedCount = domainRequests.filter(request => request.status === 'blocked').length;
        const groupRow = document.createElement('tr');
        groupRow.className = 'domain-group';
        const groupCell = document.createElement('td');
        groupCell.colSpan = 8;
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'domain-toggle';
        toggle.setAttribute('aria-expanded', String(isExpanded));
        toggle.setAttribute('aria-label', `${isExpanded ? 'طي' : 'فتح'} طلبات ${domain}`);
        const arrow = document.createElement('span');
        arrow.className = 'domain-arrow';
        arrow.textContent = '›';
        const name = document.createElement('span');
        name.className = 'domain-name';
        name.textContent = domain;
        const count = document.createElement('span');
        count.className = 'domain-count';
        count.textContent = `${domainRequests.length} طلب`;
        const summary = document.createElement('span');
        summary.className = 'domain-summary';
        summary.textContent = `محظور ${blockedCount} · غير محظور ${domainRequests.length - blockedCount}`;
        toggle.append(arrow, name, count, summary);
        toggle.addEventListener('click', () => {
            if (expandedDomains.has(domain)) expandedDomains.delete(domain);
            else expandedDomains.add(domain);
            render();
        });
        groupCell.appendChild(toggle);
        groupRow.appendChild(groupCell);
        fragment.appendChild(groupRow);
        if (!isExpanded) continue;

        for (const request of domainRequests) {
            const row = document.createElement('tr');
            const [label, stateClass] = statusLabel(request);
            appendCell(row, label, `badge ${stateClass}`);
            const code = Number(request.httpStatus) || 0;
            appendCell(row, httpLabel(request), `badge http ${code >= 400 ? 'error' : (code ? 'ok' : (request.networkState === 'pending' ? 'pending' : ''))}`);
            appendCell(row, request.domain || 'غير معروف', 'domain-cell');
            const urlCell = appendCell(row, request.url || '', 'url-cell');
            urlCell.title = request.url || '';
            appendCell(row, `${request.method || 'GET'} · ${request.type || 'other'}${request.isThirdParty ? ' · طرف ثالث' : ''}`);
            appendCell(row, Number.isFinite(request.durationMs) ? `${request.durationMs} ms` : '—');
            appendCell(row, request.remoteIp || (request.fromCache ? 'ذاكرة مؤقتة' : '—'));

            const actions = document.createElement('td');
            const actionWrap = document.createElement('div');
            actionWrap.className = 'row-actions';
            const requestId = String(request.id || `${request.url}-${request.timestamp}`);
            const detailsButton = makeButton(expandedRequestIds.has(requestId) ? 'إخفاء التفاصيل' : 'التفاصيل', '', () => {
                if (expandedRequestIds.has(requestId)) expandedRequestIds.delete(requestId);
                else expandedRequestIds.add(requestId);
                render();
            });
            actionWrap.appendChild(detailsButton);
            const probe = makeButton('فحص', '', async button => {
                button.disabled = true;
                button.textContent = 'يفحص…';
                try {
                    button.textContent = await probeUrl(request.url);
                } catch (error) {
                    button.textContent = 'فشل الفحص';
                    button.title = error.message || 'تعذر فحص الرابط';
                } finally {
                    button.disabled = false;
                }
            });
            probe.title = 'إرسال طلب HEAD لفحص اتصال الشبكة ورمز الاستجابة';
            actionWrap.appendChild(probe);

            if (request.domain && request.domain !== 'unknown') {
                const isAllowlisted = networkAllowedDomains.has(String(request.domain).toLowerCase());
                const isBlocked = request.status === 'blocked' && !isAllowlisted;
                const mode = isAllowlisted || !isBlocked ? 'block' : 'allow';
                const protection = makeButton(isAllowlisted ? 'إلغاء السماح' : (isBlocked ? 'اسمح' : 'احظر + حدّث'), mode, async button => {
                    button.disabled = true;
                    button.textContent = 'جارٍ التطبيق…';
                    try {
                        const result = await send({
                            action: 'setLoggerDomainProtection',
                            domain: request.domain,
                            mode,
                            reloadTabId: mode === 'block' ? tabId : undefined
                        });
                        if (!result.success) throw new Error(result.error || 'تعذر تعديل قاعدة الحماية.');
                        if (mode === 'allow') networkAllowedDomains.add(String(request.domain).toLowerCase());
                        else networkAllowedDomains.delete(String(request.domain).toLowerCase());
                        button.textContent = mode === 'allow' ? 'تم السماح' : 'تم الحظر';
                        setText('updated-at', mode === 'allow'
                            ? `تم السماح بـ ${request.domain} وحفظ الاستثناء بدون إعادة تحميل الصفحة.`
                            : `تم حظر ${request.domain}. جارٍ تحديث الصفحة والسجل…`);
                        await refresh();
                        setTimeout(refresh, 700);
                        setTimeout(refresh, 1800);
                    } catch (error) {
                        button.disabled = false;
                        button.textContent = isAllowlisted ? 'إلغاء السماح' : (isBlocked ? 'اسمح' : 'احظر + حدّث');
                        setText('updated-at', error.message || 'تعذر تطبيق التغيير.');
                    }
                });
                actionWrap.appendChild(protection);
            }
            actions.appendChild(actionWrap);
            row.appendChild(actions);
            fragment.appendChild(row);
            if (expandedRequestIds.has(requestId)) fragment.appendChild(createRequestDetails(request));
        }
    }
    tbody.appendChild(fragment);
}

function createRequestDetails(request) {
    const row = document.createElement('tr');
    row.className = 'request-detail-row';
    const cell = document.createElement('td');
    cell.colSpan = 8;
    const panel = document.createElement('div');
    panel.className = 'request-detail-panel';

    const requestSection = document.createElement('section');
    requestSection.className = 'detail-section';
    addSectionTitle(requestSection, 'Forward · بيانات الطلب');
    const meta = document.createElement('p');
    meta.className = 'detail-meta';
    meta.textContent = `${request.method || 'GET'} ${request.url || ''}\nالنوع: ${request.type || 'غير معروف'} · المصدر: ${request.initiator || 'غير معروف'}`;
    requestSection.appendChild(meta);
    appendHeaders(requestSection, request.requestHeaders, 'رؤوس الطلب');
    appendBody(requestSection, request.requestBodySummary, 'بيانات الطلب');
    requestSection.appendChild(createBreakpointToggle(request));
    requestSection.appendChild(createReplayEditor(request, String(request.id || `${request.url}-${request.timestamp}`)));

    const responseSection = document.createElement('section');
    responseSection.className = 'detail-section';
    addSectionTitle(responseSection, 'Response · بيانات الاستجابة');
    const responseMeta = document.createElement('p');
    responseMeta.className = 'detail-meta';
    responseMeta.textContent = `${httpLabel(request)} ${request.statusLine || ''}\nالمدة: ${Number.isFinite(request.durationMs) ? `${request.durationMs} ms` : 'قيد الانتظار'} · IP: ${request.remoteIp || 'غير متاح'}`;
    responseSection.appendChild(responseMeta);
    appendHeaders(responseSection, request.responseHeaders, 'رؤوس الاستجابة');
    const bodyNote = document.createElement('p');
    bodyNote.className = 'detail-empty';
    bodyNote.textContent = 'جسم الاستجابة متاح عندما توقف الطلب عند مرحلة الرد من خلال نقطة الاعتراض.';
    responseSection.appendChild(bodyNote);

    panel.append(requestSection, responseSection);
    cell.appendChild(panel);
    row.appendChild(cell);
    return row;
}

function renderConsoleMessages() {
    const panel = document.getElementById('console-panel');
    const list = document.getElementById('console-list');
    if (!panel || !list) return;
    panel.hidden = !consoleCaptureEnabled && siteConsoleMessages.length === 0;
    document.getElementById('console-count').textContent = String(siteConsoleMessages.length);
    document.getElementById('console-scope').textContent = consoleCaptureEnabled
        ? 'يسجل أخطاء JavaScript ورسائل console.error والـ warnings لهذا التبويب.'
        : 'التسجيل متوقف؛ الرسائل السابقة ظاهرة حتى تمسحها.';
    const toggle = document.getElementById('toggle-console');
    if (toggle) toggle.textContent = consoleCaptureEnabled ? 'إيقاف تسجيل Console' : 'بدء تسجيل Console';
    list.replaceChildren();
    for (const entry of siteConsoleMessages) {
        const item = document.createElement('article');
        item.className = `console-entry ${entry.level === 'warning' ? 'warning' : ''}`;
        const message = document.createElement('div');
        message.className = 'console-message';
        message.textContent = `[${entry.level || 'error'}] ${entry.text || ''}`;
        const source = document.createElement('div');
        source.className = 'console-source';
        const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '';
        source.textContent = `${entry.url || 'مصدر غير معروف'}${entry.line ? `:${entry.line}:${entry.column || 0}` : ''}${time ? ` · ${time}` : ''}`;
        item.append(message, source);
        list.appendChild(item);
    }
}

function createBreakpointToggle(request) {
    const wrapper = document.createElement('div');
    wrapper.className = 'replay-editor';
    let normalizedUrl = request.url || '';
    try { normalizedUrl = new URL(normalizedUrl).href; } catch (_) {}
    const enabled = breakpointUrls.has(normalizedUrl);
    const button = makeButton(enabled ? 'إزالة نقطة الاعتراض' : 'اعتراض هذا الطلب', enabled ? 'block' : '', async currentButton => {
        currentButton.disabled = true;
        try {
            const result = await send({
                action: 'setNetworkBreakpoint',
                tabId,
                url: normalizedUrl,
                enabled: !enabled
            });
            if (!result.success) throw new Error(result.error || 'تعذر إعداد نقطة الاعتراض.');
            if (enabled) breakpointUrls.delete(normalizedUrl);
            else breakpointUrls.add(normalizedUrl);
            const disableAll = document.getElementById('disable-breakpoints');
            if (disableAll) disableAll.disabled = breakpointUrls.size === 0;
            setText('updated-at', enabled ? 'تمت إزالة نقطة الاعتراض.' : 'سيقف الطلب المطابق عند المرة القادمة.');
            render();
        } catch (error) {
            currentButton.disabled = false;
            setText('updated-at', error.message || 'تعذر إعداد نقطة الاعتراض.');
        }
    });
    button.title = 'يوقف الطلب المطابق قبل إرساله، ويترك لك تعديله أو تمريره أو إلغاءه.';
    wrapper.appendChild(button);
    return wrapper;
}

async function loadNetworkDebuggerState() {
    if (!Number.isInteger(tabId) || tabId <= 0) return;
    try {
        const state = await send({ action: 'getNetworkDebuggerState', tabId });
        if (!state.success) throw new Error(state.error || 'تعذر قراءة حالة الاعتراض.');
        breakpointUrls.clear();
        (state.breakpoints || []).forEach(item => breakpointUrls.add(item.url));
        const disableAll = document.getElementById('disable-breakpoints');
        if (disableAll) disableAll.disabled = breakpointUrls.size === 0;
        pausedIntercepts.clear();
        (state.paused || []).forEach(item => pausedIntercepts.set(item.requestId, item));
        consoleCaptureEnabled = Boolean(state.consoleEnabled);
        siteConsoleMessages = Array.isArray(state.consoleMessages) ? state.consoleMessages : [];
        renderConsoleMessages();
        renderPausedRequests();
    } catch (_) {}
}

function renderPausedRequests() {
    const panel = document.getElementById('paused-panel');
    const list = document.getElementById('paused-list');
    if (!panel || !list) return;
    list.replaceChildren();
    panel.hidden = pausedIntercepts.size === 0;
    for (const paused of pausedIntercepts.values()) list.appendChild(createPausedCard(paused));
}

function createPausedCard(paused) {
    const card = document.createElement('article');
    card.className = 'paused-card';
    const heading = document.createElement('h3');
    heading.textContent = `${paused.phase === 'response' ? 'الرد متوقف' : 'الطلب متوقف'} · ${paused.method} · ${paused.url}`;
    card.appendChild(heading);

    if (paused.phase === 'request') {
        const fields = document.createElement('div');
        fields.className = 'paused-fields';
        const method = document.createElement('input');
        method.value = paused.method || 'GET';
        const url = document.createElement('input');
        url.value = paused.url || '';
        addLabeledControl(fields, 'الطريقة', method);
        addLabeledControl(fields, 'الرابط', url);

        const headers = document.createElement('textarea');
        headers.rows = 6;
        headers.spellcheck = false;
        headers.value = (paused.requestHeaders || [])
            .filter(header => !/\[مخفي/.test(header.value) && !/^(host|content-length|cookie|origin|referer|connection|user-agent)$/i.test(header.name))
            .map(header => `${header.name}: ${header.value}`).join('\n');
        addLabeledControl(fields, 'رؤوس الطلب (اكتب -Header: للحذف)', headers);
        const body = document.createElement('textarea');
        body.rows = 5;
        body.spellcheck = false;
        body.value = paused.requestBody || '';
        addLabeledControl(fields, 'جسم الطلب', body);
        card.appendChild(fields);

        const actions = document.createElement('div');
        actions.className = 'paused-actions';
        const responseCheck = document.createElement('label');
        const interceptResponse = document.createElement('input');
        interceptResponse.type = 'checkbox';
        interceptResponse.checked = true;
        responseCheck.append(interceptResponse, document.createTextNode('أوقف الاستجابة أيضًا بعد وصولها'));
        actions.appendChild(responseCheck);
        const forward = makeButton('تمرير الطلب المعدّل', 'primary', async button => {
            button.disabled = true;
            try {
                const result = await send({ action: 'continuePausedRequest', tabId, requestId: paused.requestId, options: {
                    mode: 'forward', url: url.value.trim(), method: method.value.trim().toUpperCase(),
                    headers: parseHeaderLines(headers.value), body: body.value,
                    preserveOriginalBody: Boolean(paused.requestBodyTruncated && body.value === paused.requestBody),
                    interceptResponse: interceptResponse.checked
                } });
                if (!result.success) throw new Error(result.error || 'تعذر تمرير الطلب.');
            } catch (error) {
                button.disabled = false;
                setText('updated-at', error.message || 'تعذر تمرير الطلب.');
            }
        });
        const cancel = makeButton('إلغاء الطلب', 'block', async button => {
            button.disabled = true;
            const result = await send({ action: 'continuePausedRequest', tabId, requestId: paused.requestId, options: { mode: 'cancel' } });
            if (!result.success) { button.disabled = false; setText('updated-at', result.error || 'تعذر إلغاء الطلب.'); }
        });
        actions.append(forward, cancel);
        card.appendChild(actions);
        const safety = document.createElement('div');
        safety.className = 'detail-empty';
        safety.textContent = `الرؤوس السرية تظل محفوظة داخليًا ولا تظهر هنا.${paused.requestBodyTruncated ? ' الجسم أكبر من 64 كيلوبايت؛ المعروض مقتطف، وتمريره دون تعديل يحافظ على الجسم الأصلي.' : ''} ترك الطلب مفتوحًا يوقف تحميل المورد؛ الإضافة تمرره تلقائيًا بعد 90 ثانية.`;
        card.appendChild(safety);
        return card;
    }

    const responseMeta = document.createElement('p');
    responseMeta.className = 'detail-meta';
    responseMeta.textContent = `HTTP ${paused.responseStatusCode || '—'} ${paused.responseStatusText || ''} · ${paused.resourceType || ''}`;
    card.appendChild(responseMeta);
    appendHeaders(card, paused.responseHeaders, 'رؤوس الاستجابة');

    const responseBodyHost = document.createElement('div');
    if (paused.responseBodyLoaded) {
        const status = document.createElement('input');
        status.type = 'number';
        status.min = '100';
        status.max = '599';
        status.value = String(paused.responseStatusCode || 200);
        const body = document.createElement('textarea');
        body.rows = 10;
        body.spellcheck = false;
        body.value = paused.responseBody || '';
        addLabeledControl(responseBodyHost, 'كود الرد', status);
        addLabeledControl(responseBodyHost, 'جسم الرد النصي المعدّل', body);
        const actions = document.createElement('div');
        actions.className = 'paused-actions';
        const fulfill = makeButton('تمرير الرد المعدّل', 'primary', async button => {
            button.disabled = true;
            const result = await send({ action: 'continuePausedRequest', tabId, requestId: paused.requestId, options: {
                mode: 'edit', status: Number(status.value), body: body.value
            } });
            if (!result.success) { button.disabled = false; setText('updated-at', result.error || 'تعذر تعديل الرد.'); }
        });
        actions.append(fulfill, makeButton('تمرير الرد كما وصل', '', button => finishPausedRequest(button, paused.requestId, 'forward')));
        card.append(responseBodyHost, actions);
    } else {
        const loadBody = makeButton('تحميل جسم الرد لتعديله', '', async button => {
            button.disabled = true;
            button.textContent = 'جارٍ القراءة…';
            try {
                const result = await send({ action: 'readPausedResponseBody', tabId, requestId: paused.requestId });
                if (!result.success) throw new Error(result.error || 'تعذرت قراءة الرد.');
                if (result.base64Encoded) throw new Error('الرد ثنائي وليس نصًا؛ مرّره كما وصل من دون تعديل.');
                paused.responseBody = result.body || '';
                paused.responseBodyLoaded = true;
                renderPausedRequests();
            } catch (error) {
                button.disabled = false;
                button.textContent = 'تحميل جسم الرد لتعديله';
                setText('updated-at', error.message || 'تعذرت قراءة الرد.');
            }
        });
        const forward = makeButton('تمرير الرد كما وصل', 'primary', button => finishPausedRequest(button, paused.requestId, 'forward'));
        const cancel = makeButton('إلغاء الرد', 'block', button => finishPausedRequest(button, paused.requestId, 'cancel'));
        const actions = document.createElement('div');
        actions.className = 'paused-actions';
        actions.append(loadBody, forward, cancel);
        card.appendChild(actions);
    }
    return card;
}

function parseHeaderLines(value) {
    return String(value || '').split(/\r?\n/).filter(Boolean).map(line => {
        const separator = line.indexOf(':');
        if (separator <= 0) throw new Error(`صيغة رأس غير صحيحة: ${line}`);
        return { name: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() };
    });
}

async function finishPausedRequest(button, requestId, mode) {
    button.disabled = true;
    const result = await send({ action: 'continuePausedRequest', tabId, requestId, options: { mode } });
    if (!result.success) { button.disabled = false; setText('updated-at', result.error || 'تعذر تمرير الطلب.'); }
}

function createReplayEditor(request, requestId) {
    const wrapper = document.createElement('div');
    wrapper.className = 'replay-editor';
    const toggle = makeButton(replayOpenIds.has(requestId) ? 'إخفاء أداة التعديل' : 'تعديل وإعادة إرسال', '', () => {
        if (replayOpenIds.has(requestId)) replayOpenIds.delete(requestId);
        else replayOpenIds.add(requestId);
        render();
    });
    wrapper.appendChild(toggle);
    if (!replayOpenIds.has(requestId)) return wrapper;

    const draft = replayDrafts.get(requestId) || {
        url: request.url || '',
        method: String(request.method || 'GET').toUpperCase(),
        headers: (request.requestHeaders || [])
            .filter(header => !/\[مخفي/.test(header.value)
                && !/^(host|content-length|cookie|origin|referer|connection|user-agent)$/i.test(header.name)
                && !(header.name.toLowerCase() === 'content-type' && /multipart\/form-data/i.test(header.value)))
            .map(header => `${header.name}: ${header.value}`).join('\n'),
        body: request.requestBodySummary || ''
    };
    replayDrafts.set(requestId, draft);

    const form = document.createElement('form');
    form.className = 'replay-form';
    const urlInput = document.createElement('input');
    urlInput.type = 'url';
    urlInput.required = true;
    urlInput.value = draft.url;
    addLabeledControl(form, 'الرابط', urlInput);

    const methodInput = document.createElement('select');
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
        const option = document.createElement('option');
        option.value = method;
        option.textContent = method;
        methodInput.appendChild(option);
    }
    methodInput.value = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(draft.method) ? draft.method : 'GET';
    addLabeledControl(form, 'الطريقة', methodInput);

    const headersInput = document.createElement('textarea');
    headersInput.rows = 5;
    headersInput.spellcheck = false;
    headersInput.placeholder = 'Accept: application/json';
    headersInput.value = draft.headers;
    addLabeledControl(form, 'رؤوس HTTP (سطر لكل رأس)', headersInput);

    const bodyInput = document.createElement('textarea');
    bodyInput.rows = 5;
    bodyInput.spellcheck = false;
    bodyInput.placeholder = 'جسم الطلب النصي';
    bodyInput.value = draft.body;
    addLabeledControl(form, 'جسم الطلب', bodyInput);

    const replayNote = document.createElement('div');
    replayNote.className = 'replay-note';
    replayNote.textContent = 'إعادة الإرسال تنشئ طلبًا مستقلًا ولا توقف الطلب الأصلي. تُحذف Cookies والرؤوس السرية، والبيانات المعروضة قد لا تطابق الجسم الثنائي الأصلي.';
    form.appendChild(replayNote);
    const confirmation = document.createElement('label');
    confirmation.className = 'replay-confirm';
    const confirmInput = document.createElement('input');
    confirmInput.type = 'checkbox';
    confirmation.append(confirmInput, document.createTextNode('أفهم أن الطلب قد يكرر عملية أو يغيّر بيانات على الموقع'));
    form.appendChild(confirmation);

    const rememberDraft = () => replayDrafts.set(requestId, {
        url: urlInput.value,
        method: methodInput.value,
        headers: headersInput.value,
        body: bodyInput.value
    });
    [urlInput, methodInput, headersInput, bodyInput].forEach(control => {
        control.addEventListener('input', rememberDraft);
        control.addEventListener('change', rememberDraft);
    });

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'primary';
    submit.textContent = 'إرسال الطلب المعدّل';
    form.appendChild(submit);
    const resultHost = document.createElement('div');
    const previousResult = replayResults.get(requestId);
    if (previousResult) resultHost.appendChild(createReplayResult(previousResult));
    form.addEventListener('submit', async event => {
        event.preventDefault();
        rememberDraft();
        if (!['GET', 'HEAD'].includes(methodInput.value) && !confirmInput.checked) {
            setText('updated-at', 'علّم مربع التأكيد قبل إرسال طلب قد يغيّر بيانات الموقع.');
            return;
        }
        const parsedHeaders = [];
        for (const line of headersInput.value.split(/\r?\n/).filter(Boolean)) {
            const separator = line.indexOf(':');
            if (separator <= 0) {
                setText('updated-at', `صيغة رأس غير صحيحة: ${line}`);
                return;
            }
            parsedHeaders.push({ name: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() });
        }
        submit.disabled = true;
        submit.textContent = 'جارٍ الإرسال…';
        try {
            const result = await send({
                action: 'replayHttpRequest',
                url: urlInput.value,
                method: methodInput.value,
                headers: parsedHeaders,
                body: bodyInput.value
            });
            if (!result.success) throw new Error(result.error || 'تعذرت إعادة الإرسال.');
            replayResults.set(requestId, result);
            resultHost.replaceChildren(createReplayResult(result));
            setText('updated-at', `وصل رد ${result.status} خلال ${result.elapsedMs} ms · طلب إعادة إرسال مستقل`);
        } catch (error) {
            const message = document.createElement('div');
            message.className = 'replay-error';
            message.textContent = error.message || 'تعذرت إعادة الإرسال.';
            resultHost.replaceChildren(message);
        } finally {
            submit.disabled = false;
            submit.textContent = 'إرسال الطلب المعدّل';
        }
    });
    wrapper.append(form, resultHost);
    return wrapper;
}

function addLabeledControl(container, labelText, control) {
    const label = document.createElement('label');
    label.className = 'replay-field';
    const caption = document.createElement('span');
    caption.textContent = labelText;
    label.append(caption, control);
    container.appendChild(label);
}

function createReplayResult(result) {
    const section = document.createElement('section');
    section.className = 'replay-result';
    const heading = document.createElement('strong');
    heading.textContent = `رد إعادة الإرسال: HTTP ${result.status} ${result.statusText || ''} · ${result.elapsedMs} ms${result.truncated ? ' · عُرض أول 32 كيلوبايت فقط' : ''}`;
    section.appendChild(heading);
    if (result.finalUrl) {
        const finalUrl = document.createElement('div');
        finalUrl.className = 'detail-meta';
        finalUrl.textContent = `الرابط النهائي: ${result.finalUrl}`;
        section.appendChild(finalUrl);
    }
    const responseHeaders = (result.headers || []).map(([name, value]) => ({ name, value }));
    if (responseHeaders.length) appendHeaders(section, responseHeaders, 'رؤوس الرد');
    const body = document.createElement('pre');
    body.className = 'body-preview';
    body.textContent = result.body || 'الرد لا يحتوي على نص قابل للعرض.';
    section.appendChild(body);
    return section;
}

function addSectionTitle(section, title) {
    const heading = document.createElement('h3');
    heading.textContent = title;
    section.appendChild(heading);
}

function appendHeaders(section, headers, title) {
    addSectionTitle(section, title);
    if (!Array.isArray(headers) || !headers.length) {
        const empty = document.createElement('div');
        empty.className = 'detail-empty';
        empty.textContent = 'لا توجد رؤوس مسجلة لهذا الطلب.';
        section.appendChild(empty);
        return;
    }
    const list = document.createElement('dl');
    list.className = 'header-list';
    for (const header of headers) {
        const name = document.createElement('dt');
        name.textContent = header.name;
        const value = document.createElement('dd');
        value.textContent = header.value;
        list.append(name, value);
    }
    section.appendChild(list);
}

function appendBody(section, body, title) {
    addSectionTitle(section, title);
    const preview = document.createElement('pre');
    preview.className = 'body-preview';
    preview.textContent = body || 'لا توجد بيانات نصية قابلة للعرض.';
    section.appendChild(preview);
}

function appendCell(row, value, className = '') {
    const cell = document.createElement('td');
    cell.textContent = String(value ?? '');
    if (className) cell.className = className;
    row.appendChild(cell);
    return cell;
}

function makeButton(label, className, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', () => action(button));
    return button;
}

async function probeUrl(url) {
    const result = await send({ action: 'checkNetworkUrl', url });
    if (!result.success) throw new Error(result.error || 'فشل فحص الاتصال.');
    if (result.error) throw new Error(result.error);
    return `${result.status} ${result.statusText || (result.status === 200 ? 'OK' : '')}`.trim();
}

document.querySelectorAll('[data-filter]').forEach(button => {
    button.addEventListener('click', () => {
        document.querySelectorAll('[data-filter]').forEach(item => item.classList.remove('active'));
        button.classList.add('active');
        activeFilter = button.dataset.filter;
        render();
    });
});

document.getElementById('toggle-groups').addEventListener('click', event => {
    const visibleDomains = new Set(requests
        .filter(request => {
            if (activeFilter === 'blocked' && request.status !== 'blocked') return false;
            if (activeFilter === 'allowed' && request.status === 'blocked') return false;
            if (activeFilter === 'errors' && request.status !== 'error' && Number(request.httpStatus) < 400) return false;
            if (activeFilter === 'thirdParty' && !request.isThirdParty) return false;
            if (searchValue && !`${request.domain} ${request.url} ${request.type}`.toLowerCase().includes(searchValue)) return false;
            return true;
        })
        .slice(0, 1000)
        .map(request => String(request.domain || 'غير معروف').toLowerCase()));
    const shouldExpand = [...visibleDomains].some(domain => !expandedDomains.has(domain));
    if (shouldExpand) visibleDomains.forEach(domain => expandedDomains.add(domain));
    else visibleDomains.forEach(domain => expandedDomains.delete(domain));
    event.currentTarget.textContent = shouldExpand ? 'طي كل النطاقات' : 'فتح كل النطاقات';
    render();
});

document.getElementById('search').addEventListener('input', event => {
    searchValue = event.target.value.trim().toLowerCase();
    render();
});
document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('clear').addEventListener('click', async () => {
    await send({ action: 'clearTabRequests', tabId });
    requests = [];
    render();
    refresh();
});
document.getElementById('reload-page').addEventListener('click', () => {
    if (currentTab?.id === tabId) chrome.tabs.reload(tabId);
});
document.getElementById('probe').addEventListener('click', async event => {
    const button = event.currentTarget;
    const url = document.getElementById('probe-url').value.trim();
    const output = document.getElementById('check-result');
    if (!url) { output.textContent = 'أدخل رابطًا صالحًا أولاً.'; return; }
    button.disabled = true;
    output.textContent = 'جارٍ فحص الاتصال…';
    try {
        const result = await send({ action: 'checkNetworkUrl', url });
        if (!result.success) throw new Error(result.error || 'فشل الفحص.');
        output.textContent = result.error
            ? `${result.error} · ${result.elapsedMs} ms`
            : `${result.status} ${result.statusText || (result.status === 200 ? 'OK' : '')} · ${result.elapsedMs} ms · ${result.method}${result.finalUrl && result.finalUrl !== url ? ` · تحوّل إلى ${result.finalUrl}` : ''}`;
    } catch (error) {
        output.textContent = error.message || 'تعذر فحص الشبكة.';
    } finally {
        button.disabled = false;
    }
});

document.getElementById('disable-breakpoints').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
        const result = await send({ action: 'clearNetworkBreakpoints', tabId });
        if (!result.success) throw new Error(result.error || 'تعذر إيقاف نقاط الاعتراض.');
        breakpointUrls.clear();
        await loadNetworkDebuggerState();
        render();
        setText('updated-at', 'تم إيقاف كل نقاط الاعتراض.');
    } catch (error) {
        setText('updated-at', error.message || 'تعذر إيقاف نقاط الاعتراض.');
    } finally {
        button.disabled = breakpointUrls.size === 0;
    }
});

document.getElementById('toggle-console').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
        const enabled = !consoleCaptureEnabled;
        const result = await send({ action: 'setConsoleCapture', tabId, enabled });
        if (!result.success) throw new Error(result.error || 'تعذر تشغيل تسجيل Console.');
        consoleCaptureEnabled = Boolean(result.enabled);
        renderConsoleMessages();
        setText('updated-at', consoleCaptureEnabled ? 'بدأ تسجيل أخطاء الموقع.' : 'تم إيقاف تسجيل أخطاء الموقع.');
    } catch (error) {
        setText('updated-at', error.message || 'تعذر تشغيل تسجيل Console.');
    } finally {
        button.disabled = false;
    }
});

document.getElementById('clear-console').addEventListener('click', async () => {
    const result = await send({ action: 'clearConsoleMessages', tabId });
    if (result.success) {
        siteConsoleMessages = [];
        renderConsoleMessages();
    }
});

chrome.runtime.onMessage.addListener(message => {
    if (message?.action === 'tabRequestsUpdated' && message.tabId === tabId) {
        refresh();
    } else if (message?.action === 'requestInterceptPaused' && message.tabId === tabId) {
        pausedIntercepts.set(message.requestId, message);
        renderPausedRequests();
    } else if (message?.action === 'requestInterceptFinished' && message.tabId === tabId) {
        pausedIntercepts.delete(message.requestId);
        renderPausedRequests();
        if (message.automatic) setText('updated-at', 'انتهت مهلة الاعتراض؛ تم تمرير الطلب تلقائيًا.');
    } else if (message?.action === 'siteConsoleMessage' && message.tabId === tabId) {
        siteConsoleMessages.unshift(message.entry);
        if (siteConsoleMessages.length > 300) siteConsoleMessages.length = 300;
        renderConsoleMessages();
    } else if (message?.action === 'siteConsoleCleared' && message.tabId === tabId) {
        siteConsoleMessages = [];
        renderConsoleMessages();
    } else if (message?.action === 'networkDebuggerDetached' && message.tabId === tabId) {
        breakpointUrls.clear();
        consoleCaptureEnabled = false;
        const disableAll = document.getElementById('disable-breakpoints');
        if (disableAll) disableAll.disabled = true;
        renderConsoleMessages();
        pausedIntercepts.clear();
        renderPausedRequests();
        setText('updated-at', 'انفصل Debugger عن التبويب؛ أعد تفعيل نقطة الاعتراض عند الحاجة.');
    }
});

(async () => {
    if (Number.isInteger(tabId) && tabId > 0) {
        await refreshNetworkAllowlist();
        const tabs = await chrome.tabs.get(tabId).catch(() => null);
        currentTab = tabs;
        if (tabs) {
            let host = 'صفحة المتصفح الحالية';
            try { host = new URL(tabs.url).hostname || host; } catch (_) {}
            setText('scope', `النطاق: ${host} · يتم رصد طلبات هذه الصفحة فقط.`);
            document.getElementById('probe-url').value = tabs.url?.startsWith('http') ? tabs.url : '';
        } else {
            setText('scope', 'الصفحة التي بدأ منها الفحص لم تعد متاحة.');
        }
    } else {
        setText('scope', 'افتح فاحص الشبكة من زر اللوحة الكاملة في الإضافة لاختيار الصفحة المراد فحصها.');
    }
    await loadNetworkDebuggerState();
    await refresh();
    timer = setInterval(refresh, 12000);
})();

window.addEventListener('pagehide', () => { if (timer) clearInterval(timer); });
