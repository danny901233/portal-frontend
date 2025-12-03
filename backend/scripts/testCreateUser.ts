const globalFetch = global.fetch;

const login = await globalFetch('http://localhost:4000/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'admin@receptionmate.ai',
    password: 'ChangeMe123!',
    garageId: '827efd7f-c5df-47b1-b2b0-f9a5bde39efa',
  }),
});
const loginData = await login.json();
console.log('LOGIN', login.status, loginData);

if (!loginData.token) {
  throw new Error('Missing token');
}

const token = loginData.token as string;
const payload = {
  email: `test-${Date.now()}@receptionmate.ai`,
  password: 'TestPass123!',
  role: 'USER',
  garageAccessIds: ['827efd7f-c5df-47b1-b2b0-f9a5bde39efa'],
};

const create = await fetch('http://localhost:4000/api/admin/users', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify(payload),
});
const createData = await create.json();
console.log('CREATE', create.status, createData);

if (create.status === 201 && createData?.user?.id) {
  const del = await fetch(`http://localhost:4000/api/admin/users/${createData.user.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log('DELETE', del.status);
}

export {};
