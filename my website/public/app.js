import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, query, orderBy, limit, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBWZx5WdJ8dJoI8nZlU1eA-OnOk91gj8Xk",
  authDomain: "group-a0ee4.firebaseapp.com",
  projectId: "group-a0ee4",
  storageBucket: "group-a0ee4.firebasestorage.app",
  messagingSenderId: "519444570577",
  appId: "1:519444570577:web:3a55d7010192e2ac2740f0",
  measurementId: "G-9TXCQ06MJM"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// DOM Elements
const loginView = document.getElementById('login-view');
const dashboardView = document.getElementById('dashboard-view');
const btnLogin = document.getElementById('btn-login');
const btnLogout = document.getElementById('btn-logout');
const adminEmailInput = document.getElementById('admin-email');
const adminPasswordInput = document.getElementById('admin-password');
const loginError = document.getElementById('login-error');
const crashTbody = document.getElementById('crash-tbody');

let unsubscribeReports = null;

onAuthStateChanged(auth, (user) => {
    if (user) {
        loginView.style.display = 'none';
        dashboardView.style.display = 'block';
        loadReports();
    } else {
        loginView.style.display = 'block';
        dashboardView.style.display = 'none';
        if (unsubscribeReports) unsubscribeReports();
    }
});

const loginForm = document.getElementById('login-form');

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = adminEmailInput.value;
    const pwd = adminPasswordInput.value;
    if (!email || !pwd) {
        loginError.innerText = "Please enter both email and password.";
        return;
    }
    
    loginError.innerText = "Logging in...";
    try {
        await signInWithEmailAndPassword(auth, email, pwd);
        loginError.innerText = "";
        adminEmailInput.value = "";
        adminPasswordInput.value = "";
    } catch (e) {
        loginError.innerText = "Invalid admin credentials.";
        console.error(e);
    }
});

btnLogout.addEventListener('click', async () => {
    await signOut(auth);
});

function loadReports() {
    crashTbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">Loading...</td></tr>';
    
    const q = query(collection(db, "crash_reports"), orderBy("timestamp", "desc"), limit(50));
    
    unsubscribeReports = onSnapshot(q, (snapshot) => {
        crashTbody.innerHTML = '';
        
        if (snapshot.empty) {
            crashTbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">No reports found.</td></tr>';
            return;
        }
        
        snapshot.forEach((doc) => {
            const data = doc.data();
            
            const tr = document.createElement('tr');
            
            const tdTime = document.createElement('td');
            tdTime.innerText = new Date(data.timestamp).toLocaleString();
            
            const tdCat = document.createElement('td');
            tdCat.innerHTML = `<span class="badge">${data.error_category || 'Unknown'}</span>`;
            
            const tdDom = document.createElement('td');
            tdDom.innerText = data.target_domain || 'N/A';
            
            const tdMsg = document.createElement('td');
            tdMsg.innerText = data.error_message || 'N/A';
            tdMsg.style.maxWidth = "300px";
            tdMsg.style.overflow = "hidden";
            tdMsg.style.textOverflow = "ellipsis";
            tdMsg.style.whiteSpace = "nowrap";
            tdMsg.title = data.error_message;
            
            const tdStatus = document.createElement('td');
            tdStatus.innerText = data.status || 'new';
            
            tr.appendChild(tdTime);
            tr.appendChild(tdCat);
            tr.appendChild(tdDom);
            tr.appendChild(tdMsg);
            tr.appendChild(tdStatus);
            
            crashTbody.appendChild(tr);
        });
    }, (error) => {
        console.error(error);
        crashTbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: red;">Error loading reports (Check permissions)</td></tr>';
    });
}
