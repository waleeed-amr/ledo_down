(() => {
    const ACTIVE = new Set(['downloading', 'starting', 'resolving', 'preparing', 'processing']);
    const VIDEO = new Set(['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'flv', 'wmv', 'mpeg', 'mpg', '3gp']);
    const AUDIO = new Set(['mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg', 'opus', 'wma']);
    const IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff', 'heic']);
    const DOCUMENT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'epub', 'csv']);
    const ARCHIVE = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz']);
    const SOFTWARE = new Set(['exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'appx']);
    const humanBytes = bytes => {
        const n = Number(bytes) || 0;
        if (!n) return 'الحجم غير معروف';
        const units = ['بايت', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
        return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
    };
    const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    const timestamp = item => {
        const n = Number(item.created_at) || 0;
        return n && n < 1e12 ? n * 1000 : n;
    };
    const filename = item => String(item.filename || (() => {
        try { return decodeURIComponent(new URL(item.url).pathname.split('/').pop() || ''); } catch { return ''; }
    })());
    const extension = item => filename(item).split('.').pop().toLowerCase();
    const canonicalUrl = value => {
        try { const url = new URL(value); url.hash = ''; return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, '')}${url.search}`.toLowerCase(); }
        catch { return String(value || '').trim().toLowerCase(); }
    };

    const FEATURES = [
        { id:'all', icon:'layers-3', name:'كل التنزيلات', hint:'المكتبة كاملة', test:() => true },
        { id:'active', icon:'activity', name:'قيد التنزيل', hint:'النشط الآن', test:d => ACTIVE.has(d.status) },
        { id:'completed', icon:'circle-check', name:'مكتمل', hint:'جاهز للاستخدام', test:d => d.status === 'completed' },
        { id:'queued', icon:'list-ordered', name:'في الانتظار', hint:'بانتظار دورها', test:d => d.status === 'starting' },
        { id:'paused', icon:'circle-pause', name:'متوقف مؤقتًا', hint:'يمكن استكماله', test:d => d.status === 'paused' },
        { id:'failed', icon:'circle-alert', name:'يحتاج مراجعة', hint:'تنزيلات بها أخطاء', test:d => d.status === 'error' },
        { id:'video', icon:'clapperboard', name:'فيديو', hint:'كل امتدادات الفيديو', test:d => VIDEO.has(extension(d)) },
        { id:'audio', icon:'audio-lines', name:'صوت', hint:'موسيقى وملفات صوتية', test:d => AUDIO.has(extension(d)) },
        { id:'image', icon:'image', name:'صور', hint:'صور ولقطات', test:d => IMAGE.has(extension(d)) },
        { id:'document', icon:'files', name:'مستندات', hint:'PDF وOffice وغيرها', test:d => DOCUMENT.has(extension(d)) },
        { id:'archive', icon:'archive', name:'أرشيف', hint:'ملفات مضغوطة', test:d => ARCHIVE.has(extension(d)) },
        { id:'software', icon:'package', name:'برامج', hint:'مثبتات وحزم تطبيقات', test:d => SOFTWARE.has(extension(d)) },
        { id:'unknown', icon:'circle-help', name:'حجم غير معروف', hint:'بانتظار تقدير المصدر', test:d => !(Number(d.total_size) > 0) },
        { id:'youtube', icon:'youtube', name:'YouTube', hint:'روابط يوتيوب', test:d => /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test((() => { try { return new URL(d.url).hostname; } catch { return ''; } })()) },
        { id:'telegram', icon:'send', name:'Telegram', hint:'من البوت أو تيليجرام', test:d => d.source === 'telegram' || /(^|\.)telegram\.org$/i.test((() => { try { return new URL(d.url).hostname; } catch { return ''; } })()) },
        { id:'today', icon:'sun', name:'أضيف اليوم', hint:'آخر 24 ساعة', test:d => timestamp(d) >= Date.now() - 86400000 },
        { id:'week', icon:'calendar-days', name:'هذا الأسبوع', hint:'آخر 7 أيام', test:d => timestamp(d) >= Date.now() - 7 * 86400000 },
        { id:'large', icon:'database', name:'ملفات كبيرة', hint:'أكبر من 1 جيجابايت', test:d => Number(d.total_size) >= 1024 ** 3 },
        { id:'small', icon:'file-down', name:'ملفات خفيفة', hint:'أقل من 100 ميجابايت', test:d => Number(d.total_size) > 0 && Number(d.total_size) < 100 * 1024 ** 2 },
        { id:'hour', icon:'clock-3', name:'آخر ساعة', hint:'أضيفت مؤخرًا', test:d => timestamp(d) >= Date.now() - 3600000 },
    ];

    class LibraryHub {
        constructor(host, downloads = []) {
            this.host = host;
            this.downloads = Array.isArray(downloads) ? downloads : [];
            this.filter = 'all';
            this.search = '';
            this.sort = 'newest';
            this.render();
            this.bind();
        }
        bind() {
            this.host.addEventListener('click', async event => {
                const feature = event.target.closest('[data-hub-filter]');
                if (feature) { this.filter = feature.dataset.hubFilter; this.render(); return; }
                const action = event.target.closest('[data-hub-action]');
                if (!action) return;
                if (action.dataset.hubAction === 'add') {
                    document.getElementById('nav-downloads')?.click();
                    setTimeout(() => document.getElementById('url-input')?.focus(), 80);
                    return;
                }
                const item = this.downloads.find(row => String(row.id) === action.dataset.id);
                if (!item) return;
                if (action.dataset.hubAction === 'copy') {
                    await window.electronAPI.writeClipboardText(item.url || '');
                    window.showToast?.('تم نسخ الرابط', '#10b981');
                } else if (action.dataset.hubAction === 'open' && item.save_path) {
                    window.electronAPI.showItemInFolder(item.save_path);
                } else if (action.dataset.hubAction === 'retry' && item.retryable && window.retryDownload) {
                    window.retryDownload(item.id);
                }
            });
            this.host.addEventListener('input', event => {
                if (event.target.id === 'hub-search') { this.search = event.target.value; this.renderResults(); }
            });
            this.host.addEventListener('change', event => {
                if (event.target.id === 'hub-sort') { this.sort = event.target.value; this.renderResults(); }
            });
        }
        duplicateIds() {
            const groups = new Map();
            for (const item of this.downloads) {
                const url = canonicalUrl(item.url);
                const name = filename(item).trim().toLowerCase().replace(/\s*\(\d+\)(?=\.[^.]+$)/, '');
                for (const key of [url && `url:${url}`, name && `name:${name}`]) {
                    if (!key) continue;
                    if (!groups.has(key)) groups.set(key, []);
                    groups.get(key).push(String(item.id));
                }
            }
            return new Set([...groups.values()].filter(group => group.length > 1).flat());
        }
        matches(item, duplicateSet) {
            const feature = FEATURES.find(entry => entry.id === this.filter) || FEATURES[0];
            if (this.filter === 'duplicates') return duplicateSet.has(String(item.id));
            return feature.test(item);
        }
        filtered() {
            const duplicates = this.duplicateIds();
            let rows = this.downloads.filter(item => this.matches(item, duplicates));
            const query = this.search.trim().toLocaleLowerCase();
            if (query) rows = rows.filter(item => `${filename(item)} ${item.url || ''} ${item.status || ''}`.toLocaleLowerCase().includes(query));
            if (this.sort === 'oldest') rows.sort((a, b) => timestamp(a) - timestamp(b));
            else if (this.sort === 'largest') rows.sort((a, b) => Number(b.total_size || 0) - Number(a.total_size || 0));
            else if (this.sort === 'name') rows.sort((a, b) => filename(a).localeCompare(filename(b), 'ar'));
            else rows.sort((a, b) => timestamp(b) - timestamp(a));
            return rows;
        }
        update(downloads) {
            this.downloads = Array.isArray(downloads) ? downloads : [];
            if (this.host?.classList.contains('active')) this.refreshData();
        }
        mount(host, downloads) { this.host = host; this.update(downloads); }
        refreshData() {
            const metrics = this.host.querySelectorAll('.hub-metrics article strong');
            const active = this.downloads.filter(item => ACTIVE.has(item.status)).length;
            const complete = this.downloads.filter(item => item.status === 'completed').length;
            const bytes = this.downloads.reduce((sum, item) => sum + Number(item.downloaded || 0), 0);
            [String(this.downloads.length), String(active), String(complete), humanBytes(bytes)].forEach((value, index) => {
                if (metrics[index]) metrics[index].textContent = value;
            });
            const duplicates = this.duplicateIds();
            this.host.querySelectorAll('[data-hub-filter]').forEach(button => {
                const feature = FEATURES.find(entry => entry.id === button.dataset.hubFilter);
                const count = feature ? this.downloads.filter(feature.test).length : duplicates.size;
                const countElement = button.querySelector('b');
                if (countElement) countElement.textContent = String(count);
            });
            this.renderResults();
        }
        render() {
            if (!this.host) return;
            const duplicateSet = this.duplicateIds();
            const total = this.downloads.length;
            const active = this.downloads.filter(item => ACTIVE.has(item.status)).length;
            const complete = this.downloads.filter(item => item.status === 'completed').length;
            const bytes = this.downloads.reduce((sum, item) => sum + Number(item.downloaded || 0), 0);
            const sections = [
                ['التنظيم اليومي', FEATURES.slice(0, 5)],
                ['أنواع الملفات', FEATURES.slice(5, 10)],
                ['المصادر والأنواع', FEATURES.slice(10, 15)],
                ['الوقت والحجم', FEATURES.slice(15, 20)],
            ];
            this.host.innerHTML = `<div class="hub-shell" dir="rtl">
                <header class="hub-header"><div><span class="hub-eyebrow"><i data-lucide="sparkles"></i> مساحة عمل جديدة</span><h1>المركز الذكي</h1><p>نظّم مكتبتك، اعثر على ملفاتك، وتابع التنزيلات من شاشة واحدة.</p></div><button type="button" class="hub-add-button" data-hub-action="add"><i data-lucide="plus"></i> تنزيل جديد</button></header>
                <section class="hub-metrics" aria-label="ملخص المكتبة">
                    <article><span class="hub-metric-icon blue"><i data-lucide="library-big"></i></span><div><small>إجمالي المكتبة</small><strong>${total}</strong></div></article>
                    <article><span class="hub-metric-icon cyan"><i data-lucide="arrow-down-to-line"></i></span><div><small>نشط الآن</small><strong>${active}</strong></div></article>
                    <article><span class="hub-metric-icon green"><i data-lucide="circle-check"></i></span><div><small>ملفات مكتملة</small><strong>${complete}</strong></div></article>
                    <article><span class="hub-metric-icon violet"><i data-lucide="hard-drive-download"></i></span><div><small>تم تنزيله</small><strong>${safe(humanBytes(bytes))}</strong></div></article>
                </section>
                <section class="hub-feature-panel"><div class="hub-section-heading"><div><span class="hub-eyebrow">20 طريقة للوصول السريع</span><h2>مجموعات ذكية وأدوات مكتبتك</h2></div><button class="hub-scan-button ${this.filter === 'duplicates' ? 'is-active' : ''}" type="button" data-hub-filter="duplicates"><i data-lucide="scan-search"></i><span>فحص التكرارات</span><b>${duplicateSet.size}</b></button></div>
                    <div class="hub-feature-sections">${sections.map(([title, items]) => `<section class="hub-feature-group"><h3>${title}</h3><div class="hub-feature-grid">${items.map(feature => {
                        const count = this.downloads.filter(feature.test).length;
                        return `<button type="button" class="hub-feature-card ${this.filter === feature.id ? 'selected' : ''}" data-hub-filter="${feature.id}"><span class="hub-feature-icon"><i data-lucide="${feature.icon}"></i></span><span class="hub-feature-copy"><strong>${feature.name}</strong><small>${feature.hint}</small></span><b>${count}</b></button>`;
                    }).join('')}</div></section>`).join('')}</div>
                </section>
                <section class="hub-results-panel"><div class="hub-results-heading"><div><span class="hub-eyebrow">المكتبة</span><h2>${FEATURES.find(item => item.id === this.filter)?.name || (this.filter === 'duplicates' ? 'كشف التكرارات' : 'كل التنزيلات')} <span>${this.filtered().length}</span></h2></div><div class="hub-result-controls"><label class="hub-search"><i data-lucide="search"></i><input id="hub-search" type="search" value="${safe(this.search)}" placeholder="ابحث بالاسم أو الرابط"></label><select id="hub-sort" aria-label="ترتيب النتائج"><option value="newest" ${this.sort === 'newest' ? 'selected' : ''}>الأحدث</option><option value="oldest" ${this.sort === 'oldest' ? 'selected' : ''}>الأقدم</option><option value="largest" ${this.sort === 'largest' ? 'selected' : ''}>الأكبر حجمًا</option><option value="name" ${this.sort === 'name' ? 'selected' : ''}>الاسم</option></select></div></div><div class="hub-result-list" id="hub-result-list"></div></section>
            </div>`;
            this.renderResults();
            if (window.lucide) window.lucide.createIcons({ root: this.host });
        }
        renderResults() {
            const list = this.host?.querySelector('#hub-result-list');
            if (!list) return;
            const rows = this.filtered();
            if (!rows.length) {
                list.innerHTML = `<div class="hub-empty"><i data-lucide="folder-search-2"></i><strong>لا توجد نتائج هنا</strong><span>جرّب مجموعة أخرى أو غيّر كلمات البحث.</span></div>`;
                if (window.lucide) window.lucide.createIcons({ root: list });
                const count = this.host.querySelector('.hub-results-heading h2 span');
                if (count) count.textContent = '0';
                return;
            }
            list.innerHTML = rows.slice(0, 100).map(item => {
                const state = item.status === 'completed' ? 'مكتمل' : item.status === 'error' ? 'خطأ' : item.status === 'paused' ? 'متوقف' : ACTIVE.has(item.status) ? 'نشط' : item.status || '—';
                const date = timestamp(item) ? new Intl.DateTimeFormat('ar-EG', { dateStyle:'medium' }).format(new Date(timestamp(item))) : '—';
                const name = filename(item) || 'ملف بدون اسم';
                let source = 'مصدر مباشر';
                try { source = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
                const open = item.status === 'completed' && item.save_path ? `<button type="button" data-hub-action="open" data-id="${safe(item.id)}" title="إظهار في المجلد"><i data-lucide="folder-open"></i></button>` : '';
                const retry = item.status === 'error' && item.retryable ? `<button type="button" data-hub-action="retry" data-id="${safe(item.id)}" title="إعادة المحاولة"><i data-lucide="rotate-ccw"></i></button>` : '';
                return `<article class="hub-result-row"><span class="hub-file-icon"><i data-lucide="${VIDEO.has(extension(item)) ? 'clapperboard' : AUDIO.has(extension(item)) ? 'audio-lines' : 'file'}"></i></span><div class="hub-file-main"><strong title="${safe(name)}">${safe(name)}</strong><span>${safe(source)} <i>·</i> ${safe(date)}</span></div><span class="hub-file-size">${safe(humanBytes(item.total_size))}</span><span class="hub-status hub-status-${safe(item.status)}">${safe(state)}</span><div class="hub-row-actions">${retry}${open}<button type="button" data-hub-action="copy" data-id="${safe(item.id)}" title="نسخ الرابط"><i data-lucide="copy"></i></button></div></article>`;
            }).join('') + (rows.length > 100 ? `<div class="hub-more-note">يعرض أول 100 نتيجة من ${rows.length}.</div>` : '');
            const count = this.host.querySelector('.hub-results-heading h2 span');
            if (count) count.textContent = String(rows.length);
            if (window.lucide) window.lucide.createIcons({ root: list });
        }
    }

    let instance = null;
    window.LedoLibraryHub = {
        mount(host, downloads) {
            if (instance && !instance.host?.isConnected) instance = null;
            if (instance) instance.mount(host, downloads);
            else instance = new LibraryHub(host, downloads);
        },
        update(downloads) { instance?.update(downloads); }
    };
})();
