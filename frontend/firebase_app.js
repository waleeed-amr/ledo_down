/* Public Firebase access for guest announcements and remote app configuration. */
(function () {
    const firebaseConfig = {
        apiKey: "AIzaSyBWZx5WdJ8dJoI8nZlU1eA-OnOk91gj8Xk",
        authDomain: "group-a0ee4.firebaseapp.com",
        projectId: "group-a0ee4",
        storageBucket: "group-a0ee4.firebasestorage.app",
        messagingSenderId: "519444570577",
        appId: "1:519444570577:web:3a55d7010192e2ac2740f0",
        measurementId: "G-9TXCQ06MJM"
    };

    try {
        if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
        const auth = firebase.auth();
        const db = firebase.firestore();
        const ready = new Promise((resolve, reject) => {
            let unsubscribe = () => {};
            unsubscribe = auth.onAuthStateChanged(user => {
                unsubscribe();
                if (user) {
                    resolve(user);
                    return;
                }
                auth.signInAnonymously().then(credential => resolve(credential.user)).catch(reject);
            }, reject);
        }).catch(error => {
            console.warn('Guest connection is unavailable; public announcements may not load:', error);
            return null;
        });

        window.firebaseApp = {
            auth,
            db,
            ready,
            serverTimestamp: () => firebase.firestore.FieldValue.serverTimestamp(),
            setTelegramAdminSettings: async settings => {
                await ready;
                const user = auth.currentUser;
                if (!user) throw new Error('تعذر تحديد مساحة المستخدم للمزامنة.');
                await db.collection('users').doc(user.uid).collection('account').doc('telegram_bot_settings').set({
                    ...settings,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            },
            listenTelegramAdminSettings: (onValue, onError) => {
                const user = auth.currentUser;
                if (!user) return () => {};
                return db.collection('users').doc(user.uid).collection('account').doc('telegram_bot_settings')
                    .onSnapshot(snapshot => onValue(snapshot.exists ? snapshot.data() : null), onError);
            },
            syncBotActivity: async (download, progress) => {
                await ready;
                const user = auth.currentUser;
                if (!user || !download?.id) return false;
                const title = String(download.filename || download.title || 'تنزيل من بوت تيليجرام').slice(0, 180);
                await db.collection('users').doc(user.uid).collection('activity_log').doc(`telegram_download_${String(download.id).replace(/[^A-Za-z0-9_-]/g, '_')}`).set({
                    type: 'telegram_download',
                    source: 'telegram',
                    downloadId: String(download.id),
                    title,
                    status: String(download.status || 'starting'),
                    progress: Math.max(0, Math.min(100, Number(progress ?? download.progress) || 0)),
                    size: Number(download.total_size) || 0,
                    createdAtMs: Number(download.created_at) || Date.now(),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
                return true;
            },
            listenBotActivity: (onValue, onError) => {
                const user = auth.currentUser;
                if (!user) return () => {};
                return db.collection('users').doc(user.uid).collection('activity_log').orderBy('updatedAt', 'desc').limit(50)
                    .onSnapshot(snapshot => onValue(snapshot.docs
                        .filter(doc => doc.data().type === 'telegram_download')
                        .map(doc => ({ id: doc.id, ...doc.data() }))), onError);
            },
            uploadCrashReport: async (message, stack, context = {}) => {
                try {
                    await ready;
                    await db.collection('crash_reports').add({
                        message: String(message || ''),
                        stack: stack || null,
                        context,
                        userId: auth.currentUser?.uid || 'anonymous',
                        createdAt: new Date().toISOString(),
                        userAgent: navigator.userAgent
                    });
                    return { success: true };
                } catch (error) {
                    console.error('Failed to upload crash report:', error);
                    return { success: false, error: error.message };
                }
            }
        };

        ready.finally(() => window.dispatchEvent(new Event('firebase-ready')));
    } catch (error) {
        console.warn('Guest services could not initialize:', error);
        window.firebaseApp = null;
        window.dispatchEvent(new Event('firebase-ready'));
    }
})();
