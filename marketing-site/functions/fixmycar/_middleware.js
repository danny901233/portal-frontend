// Cloudflare Pages Function — gates /fixmycar/* behind a single shared password
// with a branded login page (no username). The password and session token live
// only in this server-side function, never sent to the client.

const PASSWORD = "Nomoremissedleads";
const COOKIE = "fmc_auth";
const TOKEN = "fmc-7b3e9c2a4d8f1e6b9024aa31";

function loginPage(error) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>ReceptionMate × FixMyCar</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
  *{box-sizing:border-box;}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:"Inter",system-ui,sans-serif;background:linear-gradient(160deg,#3426cf,#251aa6);padding:20px;}
  .card{background:#fff;border-radius:20px;padding:38px 32px 32px;max-width:390px;width:100%;
    box-shadow:0 30px 70px rgba(15,23,42,.35);text-align:center;}
  .logo{display:inline-flex;background:#3426cf;border-radius:16px;padding:16px 20px;margin-bottom:22px;}
  .logo img{height:56px;width:auto;display:block;}
  h1{font-size:21px;margin:0 0 6px;color:#0f172a;letter-spacing:-.01em;font-weight:800;}
  p{font-size:14px;color:#5b6b82;margin:0 0 22px;line-height:1.5;}
  input{width:100%;padding:14px 15px;border:1px solid #e2e8f0;border-radius:11px;font-size:15px;
    font-family:inherit;margin-bottom:12px;color:#0f172a;}
  input:focus{outline:none;border-color:#3426cf;box-shadow:0 0 0 3px rgba(52,38,207,.14);}
  button{width:100%;padding:14px;border:none;border-radius:11px;background:#3426cf;color:#fff;
    font-weight:700;font-size:15px;cursor:pointer;font-family:inherit;transition:background .15s;}
  button:hover{background:#281eb0;}
  .err{color:#dc2626;font-size:13px;margin:-2px 0 12px;min-height:16px;font-weight:600;}
  .foot{margin-top:18px;font-size:11.5px;color:#94a3b8;}
</style>
</head>
<body>
  <form class="card" method="POST" autocomplete="off">
    <div class="logo"><img src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png" alt="ReceptionMate" /></div>
    <h1>FixMyCar × ReceptionMate</h1>
    <p>This page is private. Enter the password to continue.</p>
    ${error ? '<div class="err">Incorrect password — please try again.</div>' : '<div class="err"></div>'}
    <input type="password" name="password" placeholder="Password" autofocus required />
    <button type="submit">View &rarr;</button>
    <div class="foot">Private &middot; prepared for FixMyCar</div>
  </form>
</body>
</html>`;
}

export const onRequest = async (context) => {
  const { request, next } = context;
  const url = new URL(request.url);

  if (request.method === "POST") {
    let pw = "";
    try {
      const form = await request.formData();
      pw = (form.get("password") || "").toString();
    } catch (e) {}
    if (pw === PASSWORD) {
      return new Response(null, {
        status: 302,
        headers: {
          "Set-Cookie": COOKIE + "=" + TOKEN + "; Path=/fixmycar; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000",
          "Location": url.pathname,
        },
      });
    }
    return new Response(loginPage(true), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const cookie = request.headers.get("Cookie") || "";
  if (cookie.indexOf(COOKIE + "=" + TOKEN) !== -1) {
    return next();
  }

  return new Response(loginPage(false), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
};
