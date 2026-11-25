(() => {
    const TEXT = {
        title: 'أدوات الوسائط', subtitle: 'تحويل وتحرير سريع — ملفاتك تظل على جهازك.', workspace: 'مساحة العمل', files: 'الملفات', add: 'إضافة ملفات',
        drop: 'أفلت ملفات الصوت أو الفيديو هنا', browse: 'اختر من الجهاز', local: 'تتم المعالجة محليًا · بدون رفع الملفات', config: 'الإعدادات',
        delivery: 'التصدير', destination: 'مجلد الحفظ', source: 'مجلد المصدر', custom: 'مجلد مخصص', chooseFolder: 'اختر مجلد التصدير', browseFolder: 'اختيار…',
        output: 'اسم الملف الناتج', addToPreview: 'أضف ملفًا لعرض الاسم', autoRename: 'تغيير الاسم عند وجود ملف بنفس الاسم', onlyLocal: 'ملفاتك لا تغادر جهازك', start: 'بدء التصدير',
        moreFormats: 'عرض المزيد من الصيغ', allFormats: 'كل صيغ التحويل المتاحة', searchFormat: 'ابحث عن صيغة…', video: 'فيديو', audio: 'صوت', noFormats: 'لا توجد صيغ إضافية في هذا المحرك.',
        ready: 'المحركات جاهزة', missing: 'ملفات FFmpeg و ffprobe غير موجودة', loading: 'جارٍ فحص المحركات…',
        converter: 'تحويل الصيغة', trimMerge: 'قص سريع ودمج', compress: 'ضغط', targetFormat: 'صيغة الملف', bitrate: 'معدل الصوت',
        fastRemux: 'نقل سريع بلا إعادة ترميز', fastRemuxHint: 'ينقل المسارات كما هي عند تغيير الحاوية فقط.', compatible: 'الوضع التلقائي يرمّز H.264 و AAC لتوافق أفضل.',
        operation: 'العملية', quickTrim: 'قص سريع', mux: 'دمج فيديو وصوت', startTime: 'وقت البداية', endTime: 'وقت النهاية',
        instantCut: 'قص فوري بلا فقدان', instantCutHint: 'ينسخ المسارات الأصلية بسرعة؛ قد يرتبط القص بأقرب إطار رئيسي.',
        videoSource: 'ملف الفيديو', noAudio: 'مصدر فيديو بدون صوت', audioTrack: 'المسار الصوتي', container: 'صيغة الإخراج',
        muxHint: 'يُنسخ الفيديو ويُحوّل الصوت إلى AAC. ينتهي الملف عند نهاية المسار الأقصر.', presets: 'إعداد الضغط',
        balanced: 'جودة متوازنة', balancedDetail: 'CRF 23 · الدقة الأصلية · مناسبة للأرشفة', social: 'مشاركة سريعة', socialDetail: 'CRF 28 · حتى 720p',
        maximum: 'أقصى ضغط', maximumDetail: 'CRF 32 · حتى 480p · حجم أصغر', estimate: 'حجم متوقع',
        estimateHint: 'تقدير تقريبي؛ الحجم الفعلي يعتمد على محتوى الملف.', showFolder: 'عرض في المجلد', error: 'تعذّر التنفيذ',
        processing: 'جارٍ التنفيذ', done: 'اكتمل', engineHelp: 'أضف ffmpeg.exe و ffprobe.exe إلى موارد التطبيق أو ثبّتهما في PATH لتفعيل التصدير.',
        chooseVideo: 'اختر ملف فيديو', chooseAudio: 'اختر مسارًا صوتيًا',
        waveform: 'تجهيز الموجة الصوتية', waveformEmpty: 'هذا الملف لا يحتوي على مسار صوتي.', waveformHint: 'اسحب السهمين لتحديد الجزء المطلوب من الملف الكامل.',
        inspect: 'فحص الملفات وتجهيزها',
        prepareTitle: 'جارٍ تجهيز الملف', prepareHint: 'التطبيق ما زال متاحًا؛ يمكنك متابعة التقدم هنا.', remaining: 'الوقت المتبقي', calculating: 'جارٍ تقدير الوقت…',
        loadingFormats: 'جارٍ تحميل الصيغ المتاحة…', cancel: 'إغلاق', selectedDuration: 'مدة التحديد', previewSelection: 'تجربة الجزء المحدد', pausePreview: 'إيقاف المعاينة',
    };

    const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const formatSize = bytes => {
        if (!Number.isFinite(bytes)) return '—';
        const units = ['بايت', 'KB', 'MB', 'GB', 'TB']; let size = bytes, index = 0;
        while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
        return `${size.toFixed(index ? 1 : 0)} ${units[index]}`;
    };
    const formatTime = seconds => {
        const value = Math.max(0, Math.floor(Number(seconds) || 0));
        return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60].map(part => String(part).padStart(2, '0')).join(':');
    };

    class MediaTools {
        constructor(host) {
            this.host = host;
            this.controller = new AbortController();
            this.jobs = new Map();
            this.jobResolvers = new Map();
            this.starting = false;
            this.files = [];
            this.destination = 'source';
            this.folder = '';
            this.tool = 'convert';
            this.format = 'mp4';
            this.bitrate = '192k';
            this.fastRemux = false;
            this.trimMode = 'trim';
            this.lossless = false;
            this.preset = 'balanced';
            this.videoSlot = '';
            this.audioSlot = '';
            this.muxFormat = 'mp4';
            this.engineReady = null;
            this.formatCatalog = null;
            this.formatSearch = '';
            this.trimStartFraction = 0;
            this.trimEndFraction = 1;
            this.trimSourceId = '';
            this.pendingWaveforms = 0;
            this.waveformRequests = new Map();
            this.disposeWhenIdle = false;
            this.destroyed = false;
            this.previewAudio = new Audio();
            this.previewStart = 0;
            this.previewEnd = 0;
            this.previewAudio.addEventListener('timeupdate', () => {
                if (!this.previewAudio.paused && this.previewAudio.currentTime >= this.previewEnd) {
                    this.previewAudio.pause(); this.previewAudio.currentTime = this.previewStart; this.stopPlayheadAnimation(); this.updatePreviewButton(false);
                }
            });
            this.renderShell();
            this.bind();
            this.checkEngine();
        }

        q(selector) { return this.host.querySelector(selector); }
        qa(selector) { return [...this.host.querySelectorAll(selector)]; }
        get busy() { return this.jobs.size > 0; }
        get activeFiles() { return this.files; }

        renderShell() {
            this.host.innerHTML = `<div class="media-studio-shell" dir="rtl">
                <header class="media-header"><div><div class="media-eyebrow">معالجة محلية · FFmpeg و ffprobe · التنزيلات عبر yt-dlp</div><h1>${TEXT.title}</h1><p>${TEXT.subtitle}</p></div><div class="media-engine" id="media-engine-status"><span></span>${TEXT.loading}</div></header>
                <div class="media-switcher" role="tablist" aria-label="أدوات الوسائط">
                    <button class="media-tool-tab active" data-tool="convert" role="tab" aria-selected="true"><i data-lucide="repeat"></i>${TEXT.converter}</button>
                    <button class="media-tool-tab" data-tool="trim" role="tab" aria-selected="false"><i data-lucide="scissors"></i>${TEXT.trimMerge}</button>
                    <button class="media-tool-tab" data-tool="compress" role="tab" aria-selected="false"><i data-lucide="shrink"></i>${TEXT.compress}</button>
                </div>
                <div class="media-studio">
                    <section class="media-panel media-queue-panel"><div class="media-panel-heading"><div><span class="media-eyebrow">${TEXT.workspace}</span><h2>${TEXT.files} <span id="media-file-count">0</span></h2></div><button id="media-add-files" class="media-quiet-button"><i data-lucide="plus"></i>${TEXT.add}</button></div>
                        <input id="media-file-input" type="file" multiple hidden>
                        <div id="media-dropzone" class="media-dropzone" tabindex="0"><div class="media-drop-icon"><i data-lucide="upload"></i></div><strong>${TEXT.drop}</strong><span><button id="media-browse-files" type="button">${TEXT.browse}</button></span><small>${TEXT.local}</small></div>
                        <div id="media-queue" class="media-queue"></div><div id="media-empty-note" class="media-queue-note">ملفات المصدر لا تتغير أبدًا.</div>
                    </section>
                    <section class="media-panel media-settings-panel"><div class="media-config-area"><div class="media-panel-heading"><div><span class="media-eyebrow">${TEXT.config}</span><h2 id="media-config-title">${TEXT.converter}</h2></div></div><div class="media-config-body" id="media-config-body"></div></div>
                        <div class="media-export"><div class="media-panel-heading"><div><span class="media-eyebrow">${TEXT.delivery}</span><h2>${TEXT.destination}</h2></div><i data-lucide="folder" class="media-heading-icon"></i></div>
                            <div class="media-destination-tabs"><button class="active" data-destination="source">${TEXT.source}</button><button data-destination="custom">${TEXT.custom}</button></div>
                            <div class="media-folder-row" id="media-custom-folder-row" hidden><div class="media-path-box" id="media-custom-folder-label">${TEXT.chooseFolder}</div><button id="media-browse-folder" class="media-small-button">${TEXT.browseFolder}</button><button id="media-open-folder" class="media-icon-button" title="فتح المجلد"><i data-lucide="folder"></i></button></div>
                            <div class="media-output-preview"><span>${TEXT.output}</span><strong id="media-output-name">${TEXT.addToPreview}</strong></div>
                            <label class="media-checkbox"><input id="media-auto-rename" type="checkbox" checked><span>${TEXT.autoRename}</span><i data-lucide="shield"></i></label>
                            <div class="media-export-footer"><span class="media-local-note"><i data-lucide="lock"></i>${TEXT.onlyLocal}</span><button id="media-start" class="media-primary-button"><i data-lucide="sparkles"></i><span>${TEXT.start}</span></button></div>
                        </div>
                    </section>
                </div>
                <div id="media-process-overlay" class="media-process-overlay" hidden role="status" aria-live="polite"><div class="media-process-card"><span class="media-process-spinner"></span><div class="media-process-copy"><strong id="media-process-title">${TEXT.prepareTitle}</strong><span id="media-process-hint">${TEXT.prepareHint}</span><div class="media-process-track"><span id="media-process-bar"></span></div><div class="media-process-meta"><span id="media-process-speed">0%</span><span>${TEXT.remaining}: <b id="media-process-eta">${TEXT.calculating}</b></span></div></div></div></div>
            </div>`;
            if (window.lucide) lucide.createIcons({ root: this.host });
            this.renderConfig();
            this.renderQueue();
        }

        bind() {
            const signal = this.controller.signal;
            this.host.addEventListener('click', event => this.onClick(event), { signal });
            this.host.addEventListener('change', event => this.onChange(event), { signal });
            this.host.addEventListener('input', event => this.onInput(event), { signal });
            this.host.addEventListener('pointerdown', event => this.onPointerDown(event), { signal });
            this.host.addEventListener('pointermove', event => this.onPointerMove(event), { signal });
            this.host.addEventListener('pointerup', () => { this.activeTrimHandle = ''; this.dragStartClientX = undefined; }, { signal });
            this.host.addEventListener('pointercancel', () => { this.activeTrimHandle = ''; this.dragStartClientX = undefined; }, { signal });
            this.host.addEventListener('keydown', event => { if (event.key === 'Escape') this.closeFormats(); }, { signal });
            const drop = this.q('#media-dropzone');
            drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('drag-active'); }, { signal });
            drop.addEventListener('dragleave', () => drop.classList.remove('drag-active'), { signal });
            drop.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); drop.classList.remove('drag-active'); this.addFiles(event.dataTransfer.files); }, { signal });
            drop.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') this.q('#media-file-input').click(); }, { signal });
            this.removeProgressListener = window.electronAPI.onMediaProgress(data => this.onProgress(data));
            this.removePreparationListener = window.electronAPI.onMediaPreparationProgress(data => this.onPreparationProgress(data));
        }

        onClick(event) {
            const previewContainer = event.target.closest('.capcut-preview-container');
            if (previewContainer && !event.target.closest('button')) {
                this.previewSelection();
                return;
            }
            const target = event.target.closest('button');
            if (!target) return;
            if (target.matches('[data-tool]')) { this.tool = target.dataset.tool; this.renderConfig(); this.renderQueue(); }
            else if (target.matches('[data-destination]')) { this.destination = target.dataset.destination; this.qa('[data-destination]').forEach(button => button.classList.toggle('active', button === target)); this.refresh(); }
            else if (target.matches('[data-group]')) { this[target.dataset.group] = target.dataset.value; this.renderConfig(); this.renderQueue(); }
            else if (target.matches('[data-preset]')) { this.preset = target.dataset.preset; this.renderConfig(); }
            else if (target.matches('[data-show-formats]')) this.showFormats();
            else if (target.matches('[data-format-select]')) { this.format = target.dataset.formatSelect; this.closeFormats(); this.renderConfig(); }
            else if (target.matches('[data-close-formats]') || (target.classList.contains('media-format-modal') && event.target === target)) this.closeFormats();
            else if (target.id === 'media-add-files' || target.id === 'media-browse-files') this.q('#media-file-input').click();
            else if (target.id === 'media-browse-folder') this.chooseFolder();
            else if (target.id === 'media-open-folder') { if (this.folder) window.electronAPI.openPath(this.folder); }
            else if (target.matches('[data-remove]')) this.removeFile(target.dataset.remove);
            else if (target.matches('[data-open]')) { const file = this.files.find(item => item.id === target.dataset.open); if (file?.outputPath) window.electronAPI.showItemInFolder(file.outputPath); }
            else if (target.id === 'media-start') this.start();
            else if (target.id === 'media-preview-selection' || target.id === 'capcut-play-btn') this.previewSelection();
        }

        onChange(event) {
            const input = event.target;
            if (input.id === 'media-file-input') { this.addFiles(input.files); input.value = ''; }
            else if (input.id === 'media-remux') this.fastRemux = input.checked;
            else if (input.id === 'media-lossless') this.lossless = input.checked;
            else if (input.id === 'media-video-slot') { this.videoSlot = input.value; this.refresh(); }
            else if (input.id === 'media-audio-slot') { this.audioSlot = input.value; this.refresh(); }
        }

        onInput(event) {
            if (event.target.matches('.media-range-handle')) {
                const source = this.files.find(file => file.id === this.trimSourceId);
                const maximum = 100000;
                if (event.target.id === 'media-trim-start') this.trimStartFraction = Math.min(Number(event.target.value) / maximum, this.trimEndFraction - .001);
                else this.trimEndFraction = Math.max(Number(event.target.value) / maximum, this.trimStartFraction + .001);
                this.updateTimelineUI(source);
            } else if (event.target.id === 'media-format-search') {
                this.formatSearch = event.target.value;
                this.renderFormatChoices();
            }
        }

        onPointerDown(event) {
            const handle = event.target.closest('.capcut-handle') || event.target.closest('.media-trim-marker');
            if (handle) {
                event.preventDefault();
                this.activeTrimHandle = handle.id;
                handle.setPointerCapture?.(event.pointerId);
                this.setTrimFromPointer(event);
                return;
            }
            const frame = event.target.closest('.capcut-selection-frame');
            if (frame) {
                event.preventDefault();
                this.activeTrimHandle = 'capcut-selection-frame';
                this.dragStartClientX = event.clientX;
                this.initialStartFraction = this.trimStartFraction;
                this.initialEndFraction = this.trimEndFraction;
                frame.setPointerCapture?.(event.pointerId);
                return;
            }
            const stage = event.target.closest('#capcut-timeline-stage');
            if (stage) {
                event.preventDefault();
                this.activeTrimHandle = 'scrub';
                stage.setPointerCapture?.(event.pointerId);
                this.setTrimFromPointer(event);
                return;
            }
        }

        onPointerMove(event) { if (this.activeTrimHandle) this.setTrimFromPointer(event); }

        setTrimFromPointer(event) {
            const stage = this.q('#capcut-timeline-stage') || this.q('.media-waveform-stage'), source = this.files.find(file => file.id === this.trimSourceId);
            if (!stage || !source) return;
            const bounds = stage.getBoundingClientRect();
            const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
            const gap = Math.min(0.002, 1 / Math.max(2, source.duration * 10));
            if (this.activeTrimHandle === 'media-trim-start') {
                this.trimStartFraction = Math.min(fraction, this.trimEndFraction - gap);
            } else if (this.activeTrimHandle === 'media-trim-end') {
                this.trimEndFraction = Math.max(fraction, this.trimStartFraction + gap);
            } else if (this.activeTrimHandle === 'capcut-selection-frame' && this.dragStartClientX !== undefined) {
                const deltaX = event.clientX - this.dragStartClientX;
                const deltaFraction = deltaX / bounds.width;
                const windowSize = this.initialEndFraction - this.initialStartFraction;
                let newStart = this.initialStartFraction + deltaFraction;
                let newEnd = this.initialEndFraction + deltaFraction;
                if (newStart < 0) { newStart = 0; newEnd = windowSize; }
                if (newEnd > 1) { newEnd = 1; newStart = 1 - windowSize; }
                this.trimStartFraction = newStart;
                this.trimEndFraction = newEnd;
            } else if (this.activeTrimHandle === 'scrub') {
                const video = this.q('#capcut-preview-video');
                const playhead = this.q('#capcut-playhead');
                const badge = this.q('#capcut-time-badge');
                const seekTime = source.duration * fraction;
                if (video) video.currentTime = seekTime;
                if (playhead) playhead.style.left = `${fraction * 100}%`;
                if (badge) badge.textContent = formatTime(seekTime);
                return;
            }
            this.updateTimelineUI(source);
        }

        async checkEngine() {
            try {
                const status = await window.electronAPI.mediaStatus();
                this.engineReady = !!status.ffmpeg && !!status.ffprobe;
                const engine = this.q('#media-engine-status');
                if (!engine) return;
                engine.classList.toggle('unavailable', !this.engineReady);
                engine.innerHTML = `<span></span>${this.engineReady ? TEXT.ready : TEXT.missing}`;
                if (!this.engineReady) engine.title = TEXT.engineHelp;
            } catch (_) { this.engineReady = false; if (!this.q('#media-engine-status')) return; }
            this.refresh();
        }

        pillGroup(name, values, selected) {
            return `<div class="media-pill-group" role="group">${values.map(([value, label]) => `<button type="button" data-group="${name}" data-value="${value}" class="media-pill ${selected === value ? 'selected' : ''}">${label}</button>`).join('')}</div>`;
        }

        toggle(id, title, description, checked) {
            return `<label class="media-toggle-row"><span><strong>${title}</strong><small>${description}</small></span><input id="${id}" type="checkbox" ${checked ? 'checked' : ''}><i></i></label>`;
        }

        renderConfig() {
            const title = { convert: TEXT.converter, trim: TEXT.trimMerge, compress: TEXT.compress }[this.tool];
            this.q('#media-config-title').textContent = title;
            this.qa('.media-tool-tab').forEach(tab => { const active = tab.dataset.tool === this.tool; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); });
            const config = this.q('#media-config-body');
            if (this.tool === 'convert') {
                const quick = [['mp4', 'MP4'], ['mkv', 'MKV'], ['mov', 'MOV'], ['webm', 'WEBM'], ['avi', 'AVI'], ['gif', 'GIF'], ['mp3', 'MP3'], ['wav', 'WAV'], ['flac', 'FLAC'], ['m4a', 'M4A']];
                config.innerHTML = `<div class="media-field"><label>${TEXT.targetFormat}</label><div class="media-format-quick">${quick.map(([value, label]) => `<button type="button" data-group="format" data-value="${value}" class="media-pill ${this.format === value ? 'selected' : ''}">${label}</button>`).join('')}<button type="button" class="media-more-formats" data-show-formats>${TEXT.moreFormats}<i data-lucide="chevron-left"></i></button></div></div><div class="media-field" ${!['mp3','m4a','aac','opus'].includes(this.format) ? 'hidden' : ''}><label>${TEXT.bitrate}</label>${this.pillGroup('bitrate', [['320k', '320 kbps'], ['192k', '192 kbps'], ['128k', '128 kbps']], this.bitrate)}</div><div class="media-field media-toggle-field" ${!['mp4','mkv','mov'].includes(this.format) ? 'hidden' : ''}>${this.toggle('media-remux', TEXT.fastRemux, TEXT.fastRemuxHint, this.fastRemux)}<div class="media-hint">${TEXT.compatible}</div></div>`;
            } else if (this.tool === 'trim') {
                const source = this.files[0];
                if (source?.id !== this.trimSourceId) { this.trimSourceId = source?.id || ''; this.trimStartFraction = 0; this.trimEndFraction = 1; }
                config.innerHTML = `<div class="media-field"><label>${TEXT.operation}</label>${this.pillGroup('trimMode', [['trim', TEXT.quickTrim], ['mux', TEXT.mux]], this.trimMode)}</div><div ${this.trimMode !== 'trim' ? 'hidden' : ''}>${this.waveformMarkup(source)}<div class="media-field media-toggle-field">${this.toggle('media-lossless', TEXT.instantCut, TEXT.instantCutHint, this.lossless)}</div></div><div ${this.trimMode !== 'mux' ? 'hidden' : ''}><div class="media-slot-card"><span class="media-slot-number">01</span><label>${TEXT.videoSource}<small>${TEXT.noAudio}</small><select id="media-video-slot"></select></label></div><div class="media-slot-card"><span class="media-slot-number">02</span><label>${TEXT.audioTrack}<select id="media-audio-slot"></select></label></div><div class="media-field"><label>${TEXT.container}</label>${this.pillGroup('muxFormat', [['mp4', 'MP4'], ['mkv', 'MKV']], this.muxFormat)}</div><div class="media-hint">${TEXT.muxHint}</div></div>`;
                this.renderMuxSlots();
            } else {
                const presets = [['balanced', TEXT.balanced, TEXT.balancedDetail], ['social', TEXT.social, TEXT.socialDetail], ['maximum', TEXT.maximum, TEXT.maximumDetail]];
                config.innerHTML = `<div class="media-field"><label>${TEXT.presets}</label><div class="media-presets">${presets.map(([value, name, detail]) => `<button type="button" class="media-preset-card ${this.preset === value ? 'selected' : ''}" data-preset="${value}"><span class="media-radio-dot"></span><span class="media-preset-copy"><strong>${name}</strong><small>${detail}</small></span></button>`).join('')}</div></div><div class="media-estimate"><span><i data-lucide="activity"></i>${TEXT.estimate}</span><strong id="media-size-estimate">—</strong></div><div class="media-hint">${TEXT.estimateHint}</div>`;
                this.updateEstimate();
            }
            if (window.lucide) lucide.createIcons({ root: config });
            this.refresh();
            this.ensureSelectedWaveform();
            if (this.tool === 'trim' && this.trimMode === 'trim') {
                const file = this.files[0];
                if (file) { 
                    this.renderRuler(file); 
                    const video = this.q('#capcut-preview-video');
                    if (video) {
                        video.addEventListener('loadedmetadata', () => {
                            video.currentTime = file.duration * this.trimStartFraction;
                        }, { once: true });
                    }
                }
            }
        }

        ensureSelectedWaveform() {
            if (this.tool !== 'trim' || this.trimMode !== 'trim') return;
            const file = this.files[0];
            if (file?.hasAudio && !file.waveform && !file.waveformLoading && !file.waveformError) void this.prepareWaveforms([file]);
            if (file?.hasVideo && !file.thumbnails && !file.thumbnailsLoading) void this.loadThumbnails(file);
        }

        async loadThumbnails(file) {
            if (!file || !file.hasVideo || file.thumbnails || file.thumbnailsLoading) return;
            file.thumbnailsLoading = true;
            try {
                const count = Math.min(Math.max(12, Math.ceil(file.duration / 2)), 40);
                file.thumbnails = await window.electronAPI.mediaThumbnails(file.path, file.duration, count);
            } catch (_) { file.thumbnails = []; }
            file.thumbnailsLoading = false;
            if (this.destroyed) return;
            if (this.tool === 'trim') this.renderConfig();
        }

        renderRuler(file) {
            const ruler = this.q('#capcut-ruler');
            if (!ruler || !file) return;
            const duration = file.duration;
            if (!duration) return;
            ruler.innerHTML = '';
            const stage = this.q('#capcut-timeline-stage');
            const stageWidth = stage?.offsetWidth || 600;
            // Determine tick interval based on duration
            let interval;
            if (duration < 30) interval = 2;
            else if (duration < 120) interval = 10;
            else if (duration < 600) interval = 30;
            else if (duration < 3600) interval = 60;
            else interval = 300;
            
            for (let t = 0; t <= duration; t += interval) {
                const pct = (t / duration) * 100;
                const tick = document.createElement('div');
                tick.className = 'capcut-ruler-tick';
                tick.style.left = `${pct}%`;
                tick.innerHTML = `<span>${formatTime(t)}</span>`;
                ruler.appendChild(tick);
            }
        }

        waveformMarkup(file) {
            if (!file) return `<div class="media-waveform-empty">أضف ملفًا لبدء القص — اسحب الحواف الصفراء يمين وشمال زي كاب كات 🎬</div>`;
            if (!file.hasAudio && !file.hasVideo) return `<div class="media-waveform-empty">${TEXT.waveformEmpty}</div>`;
            const startTime = formatTime(file.duration * this.trimStartFraction), endTime = formatTime(file.duration * this.trimEndFraction);
            const selectedDuration = formatTime(file.duration * (this.trimEndFraction - this.trimStartFraction));
            const fileUrl = window.electronAPI.mediaFileUrl(file.path);
            const hasThumbStrip = file.thumbnails && file.thumbnails.length > 0;
            const hasWave = file.waveform;
            const isLoading = file.waveformLoading || file.thumbnailsLoading;
            
            const hasRealVideo = file.hasVideo && file.width > 0 && !file.attachedPictureIndex;
            return `
            <!-- CapCut-style Video Preview (Only for real video files) -->
            <div class="capcut-editor" dir="ltr">
                ${hasRealVideo ? `
                <div class="capcut-preview-container">
                    <video class="capcut-preview-video" id="capcut-preview-video" src="${fileUrl}" preload="metadata" muted></video>
                    <div class="capcut-preview-overlay" id="capcut-preview-overlay">
                        <button type="button" class="capcut-play-btn" id="capcut-play-btn">
                            <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"></polygon></svg>
                        </button>
                    </div>
                    <div class="capcut-time-badge" id="capcut-time-badge">${startTime}</div>
                </div>` : ''}
                
                <!-- Time Display Bar -->
                <div class="capcut-time-bar">
                    <div class="capcut-time-display">
                        <span class="capcut-time-label">البداية</span>
                        <span class="capcut-time-value" id="media-trim-start-time">${startTime}</span>
                    </div>
                    <div class="capcut-duration-badge">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/><path d="M20 8h-6"/><path d="M20 12h-9"/><path d="M20 16h-5"/></svg>
                        <span id="media-selected-time">${selectedDuration}</span>
                    </div>
                    <div class="capcut-time-display">
                        <span class="capcut-time-label">النهاية</span>
                        <span class="capcut-time-value" id="media-trim-end-time">${endTime}</span>
                    </div>
                </div>

                <!-- CapCut-style Timeline -->
                <div class="capcut-timeline-wrapper">
                    <!-- Time Ruler -->
                    <div class="capcut-ruler" id="capcut-ruler"></div>
                    
                    <!-- Thumbnail / Waveform Strip Stage -->
                    <div class="capcut-timeline-stage" id="capcut-timeline-stage">
                        <!-- Clipped Track Content -->
                        <div class="capcut-track-content">
                            ${hasThumbStrip ? `
                            <div class="capcut-thumb-strip">
                                ${file.thumbnails.map(src => `<img class="capcut-thumb" src="${src}" draggable="false">`).join('')}
                            </div>` : hasWave ? `
                            <img class="capcut-waveform-bg" src="${file.waveform}" draggable="false">` : `
                            <div class="capcut-loading-strip">
                                <div class="capcut-loading-pulse"></div>
                                <span>${isLoading ? 'جارٍ تجهيز المعاينة...' : 'أضف ملفًا'}</span>
                            </div>`}
                            
                            <!-- Dimmed areas outside selection -->
                            <div class="capcut-dim capcut-dim-start" style="width:${this.trimStartFraction * 100}%"></div>
                            <div class="capcut-dim capcut-dim-end" style="width:${(1 - this.trimEndFraction) * 100}%"></div>
                        </div>
                        
                        <!-- Floating Super-Prominent Selection Frame -->
                        <div class="capcut-selection-frame" id="capcut-selection-frame" 
                             style="left:${this.trimStartFraction * 100}%;right:${(1 - this.trimEndFraction) * 100}%">
                            <!-- Left handle: Prominent yellow pillar -->
                            <div class="capcut-handle capcut-handle-start" id="media-trim-start" title="بداية القص — اسحب للتحكم">
                                <div class="capcut-handle-tag">البداية</div>
                                <div class="capcut-handle-icon">◀</div>
                                <div class="capcut-handle-grip">
                                    <span></span><span></span><span></span>
                                </div>
                            </div>
                            <!-- Right handle: Prominent yellow pillar -->
                            <div class="capcut-handle capcut-handle-end" id="media-trim-end" title="نهاية القص — اسحب للتحكم">
                                <div class="capcut-handle-tag">النهاية</div>
                                <div class="capcut-handle-icon">▶</div>
                                <div class="capcut-handle-grip">
                                    <span></span><span></span><span></span>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Playhead -->
                        <div class="capcut-playhead" id="capcut-playhead" style="left:${this.trimStartFraction * 100}%">
                            <div class="capcut-playhead-top"></div>
                            <div class="capcut-playhead-line"></div>
                        </div>
                    </div>
                    
                    ${file.hasAudio && hasThumbStrip ? `
                    <!-- Mini waveform under thumbnails -->
                    <div class="capcut-mini-wave" id="capcut-mini-wave">
                        ${hasWave ? `<img src="${file.waveform}" draggable="false">` : '<div class="capcut-mini-wave-loading"></div>'}
                    </div>` : ''}
                </div>
                
                <!-- Controls -->
                <div class="capcut-controls">
                    <button type="button" id="media-preview-selection" class="capcut-control-btn capcut-play-control">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><polygon points="5,3 19,12 5,21"></polygon></svg>
                        تشغيل المحدد
                    </button>
                    <div class="capcut-controls-info">
                        <span>من ${startTime}</span>
                        <span class="capcut-arrow">→</span>
                        <span>إلى ${endTime}</span>
                    </div>
                </div>
            </div>`;
        }

        updatePreviewButton(playing) {
            const button = this.q('#media-preview-selection');
            if (button) {
                button.innerHTML = playing 
                    ? `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg> إيقاف` 
                    : `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><polygon points="5,3 19,12 5,21"></polygon></svg> تشغيل المحدد`;
            }
            const playBtn = this.q('#capcut-play-btn');
            if (playBtn) {
                playBtn.innerHTML = playing 
                    ? `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`
                    : `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"></polygon></svg>`;
            }
            const overlay = this.q('#capcut-preview-overlay');
            if (overlay) overlay.classList.toggle('playing', playing);
        }

        async previewSelection() {
            const file = this.files[0];
            if (!file || (!file.hasAudio && !file.hasVideo) || !file.duration) return;
            
            // Try video preview first
            const video = this.q('#capcut-preview-video');
            if (video && file.hasVideo) {
                if (!video.paused) { 
                    video.pause(); 
                    this.stopPlayheadAnimation();
                    this.updatePreviewButton(false); 
                    return; 
                }
                this.previewStart = file.duration * this.trimStartFraction;
                this.previewEnd = file.duration * this.trimEndFraction;
                if (this.previewEnd <= this.previewStart) return;
                video.currentTime = this.previewStart;
                video.muted = false;
                await video.play();
                this.startPlayheadAnimation(video, file);
                this.updatePreviewButton(true);
                
                const onTimeUpdate = () => {
                    if (video.currentTime >= this.previewEnd) {
                        video.pause();
                        video.currentTime = this.previewStart;
                        video.muted = true;
                        this.stopPlayheadAnimation();
                        this.updatePreviewButton(false);
                        video.removeEventListener('timeupdate', onTimeUpdate);
                    }
                };
                video.addEventListener('timeupdate', onTimeUpdate);
                return;
            }
            
            // Fall back to audio preview
            if (!this.previewAudio.paused) { 
                this.previewAudio.pause(); 
                this.stopPlayheadAnimation();
                this.updatePreviewButton(false); 
                return; 
            }
            this.previewStart = file.duration * this.trimStartFraction;
            this.previewEnd = file.duration * this.trimEndFraction;
            if (this.previewEnd <= this.previewStart) return;
            const url = window.electronAPI.mediaFileUrl(file.path);
            if (this.previewAudio.src !== url) { this.previewAudio.src = url; await new Promise(resolve => this.previewAudio.addEventListener('loadedmetadata', resolve, { once: true })); }
            this.previewAudio.currentTime = this.previewStart;
            await this.previewAudio.play();
            this.startPlayheadAnimation(this.previewAudio, file);
            this.updatePreviewButton(true);
        }

        startPlayheadAnimation(mediaEl, file) {
            this.stopPlayheadAnimation();
            const playhead = this.q('#capcut-playhead');
            if (!playhead) return;
            const animate = () => {
                if (mediaEl.paused) return;
                const currentFraction = mediaEl.currentTime / file.duration;
                playhead.style.left = `${currentFraction * 100}%`;
                // Update video time badge
                const badge = this.q('#capcut-time-badge');
                if (badge) badge.textContent = formatTime(mediaEl.currentTime);
                this._playheadRaf = requestAnimationFrame(animate);
            };
            this._playheadRaf = requestAnimationFrame(animate);
        }

        stopPlayheadAnimation() {
            if (this._playheadRaf) { cancelAnimationFrame(this._playheadRaf); this._playheadRaf = null; }
        }

        updateTimelineUI(file) {
            if (!file) return;
            // Update CapCut-style selection frame
            const frame = this.q('#capcut-selection-frame');
            if (frame) { frame.style.left = `${this.trimStartFraction * 100}%`; frame.style.right = `${(1 - this.trimEndFraction) * 100}%`; }
            // Update dim areas
            const dimStart = this.q('.capcut-dim-start'), dimEnd = this.q('.capcut-dim-end');
            if (dimStart) dimStart.style.width = `${this.trimStartFraction * 100}%`;
            if (dimEnd) dimEnd.style.width = `${(1 - this.trimEndFraction) * 100}%`;
            // Update time labels
            const startTime = formatTime(file.duration * this.trimStartFraction);
            const endTime = formatTime(file.duration * this.trimEndFraction);
            const selected = formatTime(file.duration * (this.trimEndFraction - this.trimStartFraction));
            const startEl = this.q('#media-trim-start-time'); if (startEl) startEl.textContent = startTime;
            const endEl = this.q('#media-trim-end-time'); if (endEl) endEl.textContent = endTime;
            const selEl = this.q('#media-selected-time'); if (selEl) selEl.textContent = selected;
            // Update time badge on video preview
            const badge = this.q('#capcut-time-badge');
            if (badge) badge.textContent = startTime;
            // Update controls info
            const infoEl = this.q('.capcut-controls-info');
            if (infoEl) infoEl.innerHTML = `<span>من ${startTime}</span><span class="capcut-arrow">→</span><span>إلى ${endTime}</span>`;
            // Update video preview position and playhead
            const video = this.q('#capcut-preview-video');
            const playhead = this.q('#capcut-playhead');
            if (video && video.paused) {
                const targetTime = this.activeTrimHandle === 'media-trim-end'
                    ? file.duration * this.trimEndFraction
                    : file.duration * this.trimStartFraction;
                video.currentTime = targetTime;
                if (badge) badge.textContent = formatTime(targetTime);
                if (playhead) {
                    const frac = this.activeTrimHandle === 'media-trim-end' ? this.trimEndFraction : this.trimStartFraction;
                    playhead.style.left = `${frac * 100}%`;
                }
            }
            // Update ruler ticks
            this.renderRuler(file);
        }

        async showFormats() {
            if (!this.formatCatalog) {
                this.formatCatalog = await window.electronAPI.mediaFormats().catch(() => []);
            }
            if (this.destroyed) return;
            this.host.querySelector('.media-format-modal')?.remove();
            const modal = document.createElement('div');
            modal.className = 'media-format-modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', TEXT.allFormats); modal.dir = 'rtl';
            modal.innerHTML = `<div class="media-format-dialog"><div class="media-format-heading"><div><span class="media-eyebrow">FFMPEG</span><h2>${TEXT.allFormats}</h2></div><button type="button" data-close-formats aria-label="${TEXT.cancel}"><i data-lucide="x"></i></button></div><label class="media-format-search"><i data-lucide="search"></i><input id="media-format-search" type="search" placeholder="${TEXT.searchFormat}"></label><div class="media-format-groups"><section><h3>${TEXT.video}</h3><div class="media-format-grid" id="media-video-formats"></div></section><section><h3>${TEXT.audio}</h3><div class="media-format-grid" id="media-audio-formats"></div></section></div></div>`;
            this.host.querySelector('.media-studio-shell').appendChild(modal);
            if (window.lucide) lucide.createIcons({ root: modal });
            this.renderFormatChoices();
            modal.querySelector('input')?.focus();
        }

        renderFormatChoices() {
            const modal = this.host.querySelector('.media-format-modal'); if (!modal) return;
            const formats = this.formatCatalog?.length ? this.formatCatalog : [
                ['mp4','MP4','video'],['mkv','MKV','video'],['mov','MOV','video'],['webm','WebM','video'],['avi','AVI','video'],['mpg','MPEG','video'],['3gp','3GP','video'],['flv','FLV','video'],['ts','MPEG-TS','video'],['ogv','OGV','video'],['gif','GIF','video'],
                ['mp3','MP3','audio'],['wav','WAV','audio'],['flac','FLAC','audio'],['m4a','M4A','audio'],['aac','AAC','audio'],['ogg','OGG','audio'],['opus','OPUS','audio'],['aiff','AIFF','audio'],['ac3','AC3','audio']
            ].map(([id,label,group]) => ({ id,label,group }));
            const query = this.formatSearch.trim().toLocaleLowerCase();
            for (const [group, containerId] of [['video','#media-video-formats'],['audio','#media-audio-formats']]) {
                const container = modal.querySelector(containerId);
                const items = formats.filter(item => item.group === group && `${item.label} ${item.id}`.toLocaleLowerCase().includes(query));
                container.innerHTML = items.length ? items.map(item => `<button type="button" data-format-select="${item.id}" class="media-format-option ${this.format === item.id ? 'selected' : ''}"><span class="media-format-badge">${escapeHtml(item.label)}</span><span>${escapeHtml(item.label)}</span><i data-lucide="${group === 'video' ? 'film' : 'music'}"></i></button>`).join('') : `<p class="media-format-empty">${TEXT.noFormats}</p>`;
            }
            if (window.lucide) lucide.createIcons({ root: modal });
        }

        closeFormats() { this.host.querySelector('.media-format-modal')?.remove(); }

        etaText(seconds) {
            if (!Number.isFinite(seconds) || seconds < 0) return TEXT.calculating;
            const total = Math.ceil(seconds);
            if (total < 60) return `${total} ثانية`;
            return `${Math.floor(total / 60)} د ${String(total % 60).padStart(2, '0')} ث`;
        }

        showProcess(title, progress = 0, remaining = NaN, speed = '') {
            const overlay = this.q('#media-process-overlay'); if (!overlay) return;
            overlay.hidden = false;
            this.q('#media-process-title').textContent = title;
            this.q('#media-process-hint').textContent = TEXT.prepareHint;
            this.q('#media-process-bar').style.width = `${Math.max(0,Math.min(100,progress))}%`;
            this.q('#media-process-speed').textContent = `${Math.max(0,Math.min(100,Math.round(progress)))}%${speed ? ` · ${speed}x` : ''}`;
            this.q('#media-process-eta').textContent = this.etaText(remaining);
        }

        hideProcess() { const overlay = this.q('#media-process-overlay'); if (overlay) overlay.hidden = true; }

        renderMuxSlots() {
            const videos = this.q('#media-video-slot'), audios = this.q('#media-audio-slot');
            if (!videos || !audios) return;
            const options = (predicate, selected, placeholder) => `<option value="">${placeholder}</option>${this.files.filter(predicate).map(file => `<option value="${file.id}" ${selected === file.id ? 'selected' : ''}>${escapeHtml(file.name)}</option>`).join('')}`;
            videos.innerHTML = options(file => file.hasVideo, this.videoSlot, TEXT.chooseVideo);
            audios.innerHTML = options(file => file.hasAudio, this.audioSlot, TEXT.chooseAudio);
        }

        updateEstimate() {
            const file = this.files[0], output = this.q('#media-size-estimate');
            if (!output) return;
            if (!file) { output.textContent = '—'; return; }
            const ratio = { balanced: 0.72, social: 0.32, maximum: 0.2 }[this.preset];
            output.innerHTML = `<span>${formatSize(file.size * ratio)}</span><small>نحو ${Math.round(ratio * 100)}٪ من الحجم الأصلي</small>`;
        }

        async addFiles(fileList) {
            const incoming = [...fileList].filter(file => file.path && !this.files.some(item => item.path === file.path));
            if (!incoming.length) return;
            const probeEta = incoming.reduce((sum,file) => sum + (Number(file.size) || 0) / (24 * 1024 * 1024), 0) + incoming.length * .35;
            this.showProcess(TEXT.inspect, 0, probeEta);
            const startedAt = Date.now();
            let completed = 0;
            const probe = async file => {
                let result;
                try { result = { ...await window.electronAPI.mediaProbe(file.path), id: crypto.randomUUID(), status: 'ready', progress: 0 }; }
                catch (error) { result = { id: crypto.randomUUID(), path: file.path, name: file.name, extension: file.name.split('.').pop(), size: file.size, duration: 0, hasVideo: false, hasAudio: false, error: error.message, status: 'error', progress: 0 }; }
                completed++;
                const progress = Math.round(completed / incoming.length * 100);
                const elapsed = (Date.now() - startedAt) / 1000;
                const remaining = completed ? elapsed / completed * (incoming.length - completed) : probeEta;
                this.showProcess(TEXT.inspect, progress, remaining);
                return result;
            };
            const added = [];
            for (const file of incoming) added.push(await probe(file));
            if (this.destroyed) return;
            this.files.push(...added);
            this.renderQueue(); this.renderConfig();
            if (!this.pendingWaveforms) this.hideProcess();
        }

        async prepareWaveforms(files) {
            if (!files.length) return;
            this.pendingWaveforms += files.length; this.refresh();
            for (let index = 0; index < files.length; index++) {
                const file = files[index];
                if (this.destroyed || !this.files.includes(file)) { this.pendingWaveforms--; continue; }
                const requestId = crypto.randomUUID();
                file.waveformRequestId = requestId; file.waveformLoading = true; this.waveformRequests.set(requestId, file);
                file.waveformQueuedSeconds = files.slice(index + 1).reduce((sum,item) => sum + item.duration, 0);
                this.showProcess(TEXT.waveform, 0, file.duration + file.waveformQueuedSeconds);
                try { file.waveform = await window.electronAPI.mediaWaveform(file.path, file.duration, requestId); }
                catch (_) { file.waveformError = 'تعذّر إنشاء العرض الصوتي'; }
                file.waveformLoading = false;
                this.waveformRequests.delete(requestId); this.pendingWaveforms--;
                if (this.destroyed) return;
                if (this.tool === 'trim') this.renderConfig();
                this.renderQueue();
            }
            if (!this.pendingWaveforms && !this.busy) this.hideProcess();
            if (this.disposeWhenIdle && !this.pendingWaveforms && !this.busy) this.destroy();
        }

        onPreparationProgress(data) {
            const file = this.waveformRequests.get(data.requestId); if (!file) return;
            const progress = data.progress || 0, speed = Number(data.speed) || 1;
            const remaining = Math.max(0, ((file.duration || 0) * (1 - progress / 100) + (file.waveformQueuedSeconds || 0)) / speed);
            this.showProcess(TEXT.waveform, progress, remaining, data.speed || '');
        }

        async chooseFolder() { const folder = await window.electronAPI.selectFolder(); if (folder) { this.folder = folder; this.refresh(); } }

        removeFile(id) {
            const file = this.files.find(item => item.id === id);
            if (file?.jobId) window.electronAPI.mediaCancel(file.jobId);
            if (file?.waveformRequestId) window.electronAPI.mediaCancel(file.waveformRequestId);
            this.files = this.files.filter(item => item.id !== id);
            this.renderQueue(); this.renderConfig();
        }

        get sourceForPreview() {
            return this.tool === 'trim' && this.trimMode === 'mux' ? this.files.find(file => file.id === this.videoSlot) : this.files[0];
        }
        outputName(file) {
            if (!file) return '';
            const suffix = this.tool === 'convert' ? '_converted' : this.tool === 'compress' ? '_compressed' : this.trimMode === 'mux' ? '_merged' : '_trimmed';
            const ext = this.tool === 'convert' ? `.${this.format}` : this.tool === 'trim' && this.trimMode === 'mux' ? `.${this.muxFormat}` : (file.extension.startsWith('.') ? file.extension : `.${file.extension}`).toLowerCase();
            return `${file.name.replace(/\.[^.]+$/, '')}${suffix}${ext}`;
        }

        refresh() {
            if (!this.host.querySelector('#media-file-count')) return;
            const file = this.sourceForPreview;
            this.q('#media-file-count').textContent = this.files.length;
            this.q('#media-output-name').textContent = file ? `الناتج: ${this.outputName(file)}` : TEXT.addToPreview;
            this.q('#media-custom-folder-row').hidden = this.destination !== 'custom';
            this.q('#media-custom-folder-label').textContent = this.folder || TEXT.chooseFolder;
            this.q('#media-empty-note').hidden = this.files.length > 0;
            this.q('#media-start').disabled = this.engineReady !== true || this.starting || this.busy || this.pendingWaveforms > 0 || !file || (this.tool === 'trim' && this.trimMode === 'mux' && !this.files.some(item => item.id === this.audioSlot));
        }

        renderQueue() {
            const queue = this.q('#media-queue'); queue.innerHTML = '';
            this.q('.media-queue-panel').classList.toggle('queue-empty', this.files.length === 0);
            this.files.forEach(file => {
                const row = document.createElement('article'); row.className = 'media-file-row'; if (file.error) row.title = file.error;
                const status = file.status === 'done' ? `<button class="media-show-file" data-open="${file.id}">${TEXT.showFolder}</button>` : file.status === 'error' ? `<span class="media-error-label" title="${escapeHtml(file.error || '')}">${TEXT.error}</span>` : `<span class="media-percent">${file.progress ? `${file.progress}%` : ''}</span>${file.speed ? `<small>${escapeHtml(file.speed)}</small>` : ''}`;
                row.innerHTML = `<div class="media-file-symbol"><i data-lucide="${file.hasVideo ? 'film' : 'music'}"></i></div><div class="media-file-details"><strong dir="auto" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong><div class="media-file-meta"><span>${file.hasVideo ? `${file.width} × ${file.height}` : file.hasAudio ? 'صوت' : 'وسائط'}</span><b>${escapeHtml(file.extension.toUpperCase().replace('.', '') || 'FILE')}</b><span>${formatTime(file.duration)}</span><span>${formatSize(file.size)}</span></div><div class="media-progress-track"><span style="width:${file.progress || 0}%"></span></div></div><div class="media-file-status">${status}</div><button class="media-remove-file" data-remove="${file.id}" aria-label="إزالة ${escapeHtml(file.name)}" title="إزالة"><i data-lucide="x"></i></button>`;
                queue.appendChild(row);
            });
            if (window.lucide) lucide.createIcons({ root: queue });
            this.updateEstimate(); this.refresh();
        }

        async start() {
            if (this.starting || this.busy || this.pendingWaveforms) return;
            const files = this.tool === 'trim' ? [this.trimMode === 'mux' ? this.files.find(file => file.id === this.videoSlot) : this.files[0]] : this.files;
            if (!files.length || files.some(file => !file)) return;
            this.starting = true;
            this.exportQueue = files.filter(file => this.files.includes(file) && file.status !== 'error');
            this.refresh();
            for (let index = 0; index < this.exportQueue.length; index++) {
                const file = this.exportQueue[index];
                if (!this.files.includes(file) || file.status === 'error') continue;
                file.status = 'processing'; file.progress = 0; this.renderQueue();
                try {
                    const sourceDuration = this.files.find(item => item.id === this.trimSourceId)?.duration || file.duration;
                    const start = this.tool === 'trim' && this.trimMode === 'trim' ? sourceDuration * this.trimStartFraction : 0;
                    const end = this.tool === 'trim' && this.trimMode === 'trim' ? sourceDuration * this.trimEndFraction : 0;
                    this.showProcess(TEXT.processing, 0, file.duration + this.exportQueue.slice(index + 1).reduce((sum,item) => sum + item.duration,0));
                    const result = await window.electronAPI.mediaStart({
                        tool: this.tool, sourcePath: file.path, duration: file.duration, destination: this.destination, outputDirectory: this.folder,
                        autoRename: this.q('#media-auto-rename').checked,
                        format: this.tool === 'trim' && this.trimMode === 'mux' ? this.muxFormat : this.format,
                        bitrate: this.bitrate, fastRemux: this.fastRemux, mode: this.trimMode,
                        audioPath: this.files.find(item => item.id === this.audioSlot)?.path,
                        start, end, lossless: this.lossless, preset: this.preset, attachedPictureIndex: file.attachedPictureIndex, hasVideo: file.hasVideo,
                    });
                    file.jobId = result.jobId; this.jobs.set(result.jobId, file.id);
                    await new Promise(resolve => this.jobResolvers.set(result.jobId, resolve));
                } catch (error) { file.status = 'error'; file.error = error.message; }
                this.renderQueue();
            }
            this.starting = false;
            this.refresh();
            if (!this.busy && !this.pendingWaveforms) this.hideProcess();
            if (this.disposeWhenIdle && !this.busy && !this.pendingWaveforms) this.destroy();
        }

        onProgress(data) {
            const fileId = this.jobs.get(data.jobId); if (!fileId) return;
            const file = this.files.find(item => item.id === fileId);
            if (data.error) { if (file) { file.status = 'error'; file.error = data.error; } this.jobs.delete(data.jobId); this.jobResolvers.get(data.jobId)?.(); this.jobResolvers.delete(data.jobId); }
            else if (data.done) { if (file) { file.status = 'done'; file.progress = 100; file.outputPath = data.outputPath; } this.jobs.delete(data.jobId); this.jobResolvers.get(data.jobId)?.(); this.jobResolvers.delete(data.jobId); }
            else if (file) { file.progress = data.progress || 0; file.speed = data.speed || file.speed || ''; }
            const progress = file?.progress || (data.done ? 100 : 0);
            const speed = Number.parseFloat(String(file?.speed || data.speed || '').replace('x','')) || 1;
            const currentRemaining = (file?.duration || 0) * (1 - progress / 100);
            const nextIndex = (this.exportQueue || []).findIndex(item => item.id === fileId) + 1;
            const queuedRemaining = (this.exportQueue || []).slice(Math.max(0,nextIndex)).filter(item => this.files.includes(item)).reduce((sum,item) => sum + item.duration,0);
            if (this.busy) this.showProcess(TEXT.processing, progress, (currentRemaining + queuedRemaining) / speed, speed > 1 ? speed.toFixed(1) : '');
            else if (!this.pendingWaveforms) this.hideProcess();
            this.renderQueue();
            if (!this.busy && !this.starting && !this.pendingWaveforms && this.disposeWhenIdle) this.destroy();
        }

        mount(host) { this.host = host; this.disposeWhenIdle = false; }
        leave() { if (this.busy || this.starting || this.pendingWaveforms) this.disposeWhenIdle = true; else this.destroy(); }
        destroy() {
            this.destroyed = true;
            this.stopPlayheadAnimation();
            const video = this.host.querySelector('#capcut-preview-video');
            if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
            this.previewAudio.pause(); this.previewAudio.removeAttribute('src'); this.previewAudio.load();
            this.controller.abort(); this.removeProgressListener?.();
            this.removePreparationListener?.();
            this.host.innerHTML = '';
            if (window.LedoMediaTools?.instance === this) window.LedoMediaTools.instance = null;
        }
    }

    window.LedoMediaTools = {
        instance: null,
        mount(host) { if (this.instance) this.instance.mount(host); else this.instance = new MediaTools(host); },
        leave() { this.instance?.leave(); },
    };
})();
