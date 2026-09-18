/*
 * Firebase App - Compat SDK (works in Electron without ES modules)
 * Handles: Auth (Username/Password, Anonymous), ImgBB Avatar Upload, Firestore Profile
 */

// Firebase Compat SDKs are loaded via script tags in index.html
// This file runs AFTER those scripts are loaded

(function() {
    const firebaseConfig = {
        apiKey: "AIzaSyBWZx5WdJ8dJoI8nZlU1eA-OnOk91gj8Xk",
        authDomain: "group-a0ee4.firebaseapp.com",
        projectId: "group-a0ee4",
        storageBucket: "group-a0ee4.firebasestorage.app",
        messagingSenderId: "519444570577",
        appId: "1:519444570577:web:3a55d7010192e2ac2740f0",
        measurementId: "G-9TXCQ06MJM"
    };

    // Initialize Firebase
    if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
    }

    const auth = firebase.auth();
    const db = firebase.firestore();

    const IMGBB_API_KEY = "91533902a14305cb6d6a3f682c123dcb";
    const VIRTUAL_DOMAIN = "@ledodown.local";

    window.firebaseApp = {
        auth,
        db,

        // Login with Username
        login: async (username, password) => {
            try {
                const email = username.trim().toLowerCase() + VIRTUAL_DOMAIN;
                const cred = await auth.signInWithEmailAndPassword(email, password);
                return { success: true, user: cred.user };
            } catch (error) {
                let msg = error.message;
                if (error.code === 'auth/user-not-found') msg = 'Username not found. Register first!';
                if (error.code === 'auth/wrong-password') msg = 'Incorrect password.';
                if (error.code === 'auth/invalid-credential') msg = 'Invalid username or password.';
                if (error.code === 'auth/too-many-requests') msg = 'Too many failed attempts. Try again later.';
                return { success: false, error: msg };
            }
        },

        // Register with Username
        register: async (username, password) => {
            try {
                if (username.trim().length < 3) {
                    return { success: false, error: "Username must be at least 3 characters." };
                }
                if (password.length < 6) {
                    return { success: false, error: "Password must be at least 6 characters." };
                }
                const email = username.trim().toLowerCase() + VIRTUAL_DOMAIN;
                const cred = await auth.createUserWithEmailAndPassword(email, password);

                // Set displayName
                await cred.user.updateProfile({ displayName: username.trim() });

                // Create user doc in Firestore
                await db.collection("users").doc(cred.user.uid).set({
                    username: username.trim(),
                    createdAt: new Date().toISOString(),
                    photoURL: null
                });

                return { success: true, user: cred.user };
            } catch (error) {
                let msg = error.message;
                if (error.code === 'auth/email-already-in-use') msg = 'This username is already taken!';
                if (error.code === 'auth/weak-password') msg = 'Password is too weak (min 6 characters).';
                return { success: false, error: msg };
            }
        },

        // Login Anonymously
        loginAnon: async () => {
            try {
                const cred = await auth.signInAnonymously();
                return { success: true, user: cred.user };
            } catch (error) {
                return { success: false, error: error.message };
            }
        },

        // Logout
        logout: async () => {
            await auth.signOut();
        },

        // Upload Avatar to ImgBB
        uploadAvatar: async (file) => {
            if (!auth.currentUser) return { success: false, error: "Not logged in" };

            const formData = new FormData();
            formData.append("image", file);

            try {
                const response = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
                    method: "POST",
                    body: formData
                });
                const data = await response.json();

                if (data.success) {
                    const imageUrl = data.data.display_url;

                    await auth.currentUser.updateProfile({ photoURL: imageUrl });

                    if (!auth.currentUser.isAnonymous) {
                        await db.collection("users").doc(auth.currentUser.uid).set(
                            { photoURL: imageUrl },
                            { merge: true }
                        );
                    }

                    return { success: true, url: imageUrl };
                } else {
                    return { success: false, error: "ImgBB upload failed" };
                }
            } catch (error) {
                return { success: false, error: error.message };
            }
        },

        // Chat System
        sendChatMessage: async (messageText) => {
            if (!auth.currentUser) return { success: false, error: "Not logged in" };
            const text = String(messageText || '').trim();
            if (!text) return { success: false, error: "Message cannot be empty" };
            if (text.length > 3000) return { success: false, error: "Message is too long (maximum 3000 characters)" };
            try {
                const uid = auth.currentUser.uid;
                const chatRef = db.collection("chats").doc(uid);
                
                // Ensure chat doc exists
                await chatRef.set({
                    userId: uid,
                    email: auth.currentUser.email || 'anon@local',
                    lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
                    lastMessage: text,
                    lastSender: 'user',
                    unreadAdmin: true, // admin needs to read this
                    unreadUser: false
                }, { merge: true });

                // Add message
                await chatRef.collection("messages").add({
                    sender: uid,
                    text,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    isAdmin: false
                });
                return { success: true };
            } catch (error) {
                return { success: false, error: error.message };
            }
        },

        listenToChat: (callback) => {
            if (!auth.currentUser) return null;
            let receivedInitialSnapshot = false;
            return db.collection("chats")
                .doc(auth.currentUser.uid)
                .collection("messages")
                .orderBy("createdAt", "asc")
                .onSnapshot(
                    (snapshot) => {
                        const messages = [];
                        snapshot.forEach((doc) => {
                            messages.push({ id: doc.id, ...doc.data() });
                        });
                        const addedMessages = receivedInitialSnapshot
                            ? snapshot.docChanges().filter(change => change.type === 'added').map(change => ({ id: change.doc.id, ...change.doc.data() }))
                            : [];
                        callback(messages, addedMessages, !receivedInitialSnapshot);
                        receivedInitialSnapshot = true;
                    },
                    (error) => console.error("Chat listen error:", error)
                );
        },

        markChatRead: async () => {
            if (!auth.currentUser) return;
            try {
                await db.collection("chats").doc(auth.currentUser.uid).set({
                    unreadUser: false,
                    lastReadAt: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            } catch (error) {
                console.debug("Could not mark chat read:", error);
            }
        },

        // Listen to Inbox Messages
        listenToInbox: (callback) => {
            if (!auth.currentUser || auth.currentUser.isAnonymous) return null;
            return db.collection("users")
                .doc(auth.currentUser.uid)
                .collection("messages")
                .orderBy("createdAt", "desc")
                .onSnapshot(
                    (snapshot) => {
                        const messages = [];
                        snapshot.forEach((doc) => {
                            messages.push({ id: doc.id, ...doc.data() });
                        });
                        callback(messages);
                    },
                    (error) => {
                        console.error("Inbox listen error:", error);
                    }
                );
        },

        // Auth state listener
        onAuthStateChanged: (callback) => {
            auth.onAuthStateChanged(callback);
        },

        // Upload Crash Report
        uploadCrashReport: async (errorMsg, stack, context = {}) => {
            try {
                await db.collection("crash_reports").add({
                    message: errorMsg,
                    stack: stack || null,
                    context: context,
                    userId: auth.currentUser ? auth.currentUser.uid : 'anonymous',
                    email: auth.currentUser ? auth.currentUser.email : 'anon@local',
                    createdAt: new Date().toISOString(),
                    userAgent: navigator.userAgent
                });
                return { success: true };
            } catch (error) {
                console.error("Failed to upload crash report:", error);
                return { success: false, error: error.message };
            }
        },

        // Listen to User Document for status changes (e.g. bans, deletions)
        listenToUserStatus: (callback) => {
            if (!auth.currentUser || auth.currentUser.isAnonymous) return null;
            return db.collection("users")
                .doc(auth.currentUser.uid)
                .onSnapshot(
                    (doc) => {
                        // Pass doc.data() if exists, else null (deleted)
                        callback(doc.exists ? doc.data() : null, null);
                    },
                    (error) => {
                        console.error("User status listen error:", error);
                        callback(null, error);
                    }
                );
        }
    };

    // Signal ready
    window.dispatchEvent(new Event('firebase-ready'));
})();
