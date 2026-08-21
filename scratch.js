import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, limit, query, where, doc, getDoc } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyA0u-RvKNeAf_ey3Ck8l21R15C1nCpkB-M",
  authDomain: "docula-c9731.firebaseapp.com",
  projectId: "docula-c9731",
  storageBucket: "ydocula-c9731.firebasestorage.app",
  messagingSenderId: "34543217368",
  appId: "1:34543217368:web:8cb0769290b28ae57d45ad"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function inspect() {
  const q = query(collection(db, 'documents'), limit(10));
  const snap = await getDocs(q);
  snap.forEach(d => {
    const data = d.data();
    console.log(`Doc: ${d.id}, parentId: ${data.parentId}, path: ${JSON.stringify(data.path)}`);
  });
}
inspect().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
