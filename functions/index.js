const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

exports.onUserStatusChange = functions.firestore
  .document("users/{uid}")
  .onUpdate(async (change, context) => {
    const newValue = change.after.data();
    const previousValue = change.before.data();
    const uid = context.params.uid;

    const wasBanned = previousValue.banned === true || previousValue.status === "disabled";
    const isBanned = newValue.banned === true || newValue.status === "disabled";

    if (!wasBanned && isBanned) {
      // User was just banned
      console.log(`Banning user ${uid}`);
      try {
        await admin.auth().updateUser(uid, {
          disabled: true
        });
        console.log(`Successfully disabled Auth for user ${uid}`);
      } catch (error) {
        console.error(`Error disabling Auth for user ${uid}:`, error);
      }
    } else if (wasBanned && !isBanned) {
      // User was just unbanned
      console.log(`Unbanning user ${uid}`);
      try {
        await admin.auth().updateUser(uid, {
          disabled: false
        });
        console.log(`Successfully enabled Auth for user ${uid}`);
      } catch (error) {
        console.error(`Error enabling Auth for user ${uid}:`, error);
      }
    }
    
    // Also handle user deletion from Auth if deleted from Firestore via Admin UI
    if (newValue.deleted === true && previousValue.deleted !== true) {
      console.log(`Deleting user ${uid} from Auth due to Firestore deletion`);
      try {
        await admin.auth().deleteUser(uid);
        console.log(`Successfully deleted Auth for user ${uid}`);
      } catch (error) {
        console.error(`Error deleting Auth for user ${uid}:`, error);
      }
    }
  });
