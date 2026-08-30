const fs = require('fs');
const https = require('https');
const path = require('path');

const vendorDir = path.join(__dirname, 'frontend', 'vendor');
if (!fs.existsSync(vendorDir)) {
    fs.mkdirSync(vendorDir, { recursive: true });
}

const libs = [
    { url: 'https://cdn.jsdelivr.net/npm/axios/dist/axios.min.js', name: 'axios.min.js' },
    { url: 'https://cdn.jsdelivr.net/npm/toastify-js/src/toastify.min.js', name: 'toastify.min.js' },
    { url: 'https://cdn.jsdelivr.net/npm/toastify-js/src/toastify.min.css', name: 'toastify.min.css' },
    { url: 'https://cdn.jsdelivr.net/npm/chart.js', name: 'chart.js' },
    { url: 'https://cdn.plyr.io/3.7.8/plyr.js', name: 'plyr.js' },
    { url: 'https://cdn.plyr.io/3.7.8/plyr.css', name: 'plyr.css' },
    { url: 'https://cdn.jsdelivr.net/npm/sweetalert2@11', name: 'sweetalert2.min.js' },
    { url: 'https://cdn.jsdelivr.net/npm/sortablejs@latest/Sortable.min.js', name: 'Sortable.min.js' },
    { url: 'https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js', name: 'confetti.browser.min.js' },
    { url: 'https://unpkg.com/lucide@latest', name: 'lucide.min.js' },
    { url: 'https://unpkg.com/@popperjs/core@2', name: 'popper.min.js' },
    { url: 'https://unpkg.com/tippy.js@6', name: 'tippy.min.js' },
    { url: 'https://unpkg.com/tippy.js@6/animations/scale.css', name: 'scale.css' },
    { url: 'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js', name: 'gsap.min.js' },
    { url: 'https://cdnjs.cloudflare.com/ajax/libs/dayjs/1.11.10/dayjs.min.js', name: 'dayjs.min.js' },
    { url: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r134/three.min.js', name: 'three.min.js' },
    { url: 'https://cdn.jsdelivr.net/npm/vanta@latest/dist/vanta.halo.min.js', name: 'vanta.halo.min.js' }
];

function download(url, dest) {
    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
                let loc = response.headers.location;
                if (!loc.startsWith('http')) {
                    const parsed = new URL(url);
                    loc = parsed.origin + loc;
                }
                return download(loc, dest).then(resolve).catch(reject);
            }
            if (response.statusCode !== 200) {
                return reject(new Error(`Failed to download ${url}: ${response.statusCode}`));
            }
            const file = fs.createWriteStream(dest);
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => reject(err));
        });
    });
}

async function main() {
    for (const lib of libs) {
        console.log('Downloading ' + lib.name + '...');
        try {
            await download(lib.url, path.join(vendorDir, lib.name));
            console.log('Success: ' + lib.name);
        } catch(e) {
            console.error('Error: ' + e.message);
        }
    }
}
main();
