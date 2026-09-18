# Securing the Ledo admin dashboard

The dashboard now requires the Firebase Auth custom claim `admin: true` for
every administrative read or write. This prevents an ordinary signed-in user
from publishing an announcement or a malicious update link.

Before deploying `firestore.rules`, add the claim to each dashboard operator
with a trusted Firebase Admin SDK environment. The operator must sign out and
back in after the claim is set so Firebase issues a fresh token.

```js
await admin.auth().setCustomUserClaims("FIREBASE_USER_UID", { admin: true });
```

Then deploy the rules and hosting from the project root:

```powershell
npx firebase-tools deploy --only firestore:rules,hosting
```

In the dashboard, open **App Releases** to publish an HTTPS installer URL,
release notes, channel, and optional SHA-256. Use **Public App Links** on that
same page to connect the official website, privacy policy, terms, and support
page to the desktop app’s About screen.
