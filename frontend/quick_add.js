const API_URL = 'http://127.0.0.1:8000/api';

const input = document.getElementById('url-input');
const btnDownload = document.getElementById('btn-download');
const statusBar = document.getElementById('status-bar');
const statusText = document.getElementById('status-text');
const pillsContainer = document.getElementById('quality-pills');

let selectedQuality = 'best';

// Quality Pill Selection
pillsContainer.querySelectorAll('.pill').forEach(pill => {
    pill.addEventListener('click', () => {
        pillsContainer.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        selectedQuality = pill.dataset.value;
    });
});

function showStatus(text, isError = false) {
    statusText.innerText = text;
    statusBar.style.display = 'flex';
    statusBar.classList.toggle('error', isError);
}

function hideStatus() {
    statusBar.style.display = 'none';
    statusBar.classList.remove('error');
}

input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        window.close();
        window.blur();
    }
    if (e.key === 'Enter') {
        startDownload();
    }
});

btnDownload.addEventListener('click', startDownload);

async function startDownload() {
    const url = input.value.trim();
    if (!url) {
        showStatus('Please paste a URL first', true);
        setTimeout(hideStatus, 2000);
        return;
    }

    input.disabled = true;
    btnDownload.disabled = true;
    showStatus('Starting download...');

    try {
        let defaultPath = null;
        try {
            const saved = localStorage.getItem('ledo_settings');
            if (saved) {
                const settings = JSON.parse(saved);
                defaultPath = settings.defaultSavePath;
            }
        } catch (e) {
            console.error('Failed to read settings from localStorage', e);
        }

        await axios.post(`${API_URL}/download`, { 
            url: url, 
            save_path: defaultPath, 
            quality: selectedQuality,
            cookies: window.tempCookies || null,
            user_agent: window.tempUA || null
        });
        
        showStatus('Download started! Check the main app.');
        setTimeout(() => {
            input.value = '';
            input.disabled = false;
            btnDownload.disabled = false;
            hideStatus();
            window.blur();
        }, 1500);

    } catch (error) {
        console.error(error);
        showStatus('Failed to start download. Is the backend running?', true);
        setTimeout(() => {
            input.disabled = false;
            btnDownload.disabled = false;
            hideStatus();
        }, 3000);
    }
}

// Auto focus when window becomes visible
window.addEventListener('focus', () => {
    input.focus();
    input.select();
});
