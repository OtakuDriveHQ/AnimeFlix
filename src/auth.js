/**
 * auth.js
 *
 * Authentication handler for Cloudflare Worker:
 * - Session cookies for browser UI
 * - Basic Auth for API/cURL
 * - Beautiful Dark Theme Login Page
 */

const DEFAULT_USERNAME = "admin9122";
const DEFAULT_PASSWORD = "Harry@2026#";

/**
 * Compute the auth token for a given user & password
 */
export function getAuthToken(username, password) {
  // Simple Base64 token of credentials
  return btoa(`${username}:${password}`);
}

/**
 * Check if the incoming request is authenticated
 */
export function isAuthenticated(request, env) {
  const expectedUser = env?.AUTH_USERNAME || DEFAULT_USERNAME;
  const expectedPass = env?.AUTH_PASSWORD || DEFAULT_PASSWORD;
  const expectedToken = getAuthToken(expectedUser, expectedPass);

  // 1. Check Cookie: auth_token
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  for (const c of cookies) {
    if (c.startsWith("auth_token=")) {
      const val = c.slice("auth_token=".length);
      if (val === expectedToken) return true;
    }
  }

  // 2. Check Authorization header: Basic or Bearer
  const authHeader = request.headers.get("Authorization") || "";
  if (authHeader.startsWith("Basic ")) {
    try {
      const decoded = atob(authHeader.slice(6).trim());
      const [u, p] = decoded.split(":");
      if (u === expectedUser && p === expectedPass) return true;
    } catch (e) {}
  } else if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token === expectedToken) return true;
  }

  return false;
}

/**
 * Render the HTML login page
 */
export function renderLoginPage(error = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Login - ToonWorld4All Scraper</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: #0d0d14;
  color: #e2e8f0;
  font-family: system-ui, -apple-system, sans-serif;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 16px;
}
.login-card {
  background: #161622;
  border: 1px solid #2a2a40;
  border-radius: 12px;
  width: 100%;
  max-width: 380px;
  padding: 28px 24px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.5);
}
.brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-bottom: 24px;
}
.brand-icon {
  font-size: 26px;
}
.brand-title {
  font-size: 18px;
  font-weight: 800;
  color: #fff;
  letter-spacing: -0.02em;
}
.brand-sub {
  font-size: 12px;
  color: #7c3aed;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  text-align: center;
  margin-top: -18px;
  margin-bottom: 20px;
}
.form-group {
  margin-bottom: 16px;
}
label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: #94a3b8;
  margin-bottom: 6px;
}
input {
  width: 100%;
  background: #10101c;
  border: 1px solid #2d2d45;
  border-radius: 8px;
  color: #fff;
  padding: 10px 12px;
  font-size: 14px;
  outline: none;
  transition: border-color 0.15s;
}
input:focus {
  border-color: #7c3aed;
}
.btn-submit {
  width: 100%;
  background: #7c3aed;
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 12px;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  margin-top: 8px;
  transition: background 0.15s;
}
.btn-submit:hover {
  background: #6d28d9;
}
.error-msg {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid #ef4444;
  color: #fca5a5;
  padding: 10px;
  border-radius: 8px;
  font-size: 13px;
  margin-bottom: 16px;
  text-align: center;
}
.footer-text {
  text-align: center;
  font-size: 11px;
  color: #64748b;
  margin-top: 20px;
}
</style>
</head>
<body>
<div class="login-card">
  <div class="brand">
    <span class="brand-icon">🔒</span>
    <span class="brand-title">Protected Scraper</span>
  </div>
  <div class="brand-sub">ToonWorld4All &bull; GDFlix</div>

  ${error ? `<div class="error-msg">${error}</div>` : ""}

  <form method="POST" action="/login">
    <div class="form-group">
      <label for="username">Login ID / Username</label>
      <input type="text" id="username" name="username" required autocomplete="username" placeholder="Enter username" autofocus />
    </div>
    <div class="form-group">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password" placeholder="Enter password" />
    </div>
    <button type="submit" class="btn-submit">Sign In &rarr;</button>
  </form>

  <div class="footer-text">
    Protected Worker &bull; Version 2.0
  </div>
</div>
</body>
</html>`;
}

/**
 * Handle Login request (GET /login or POST /login)
 */
export async function handleLogin(request, env) {
  const expectedUser = env?.AUTH_USERNAME || DEFAULT_USERNAME;
  const expectedPass = env?.AUTH_PASSWORD || DEFAULT_PASSWORD;

  if (request.method === "GET") {
    // If already logged in, redirect to /posts?format=html
    if (isAuthenticated(request, env)) {
      return new Response(null, {
        status: 302,
        headers: { Location: "/posts?format=html" },
      });
    }
    return new Response(renderLoginPage(), {
      headers: { "Content-Type": "text/html;charset=UTF-8" },
    });
  }

  if (request.method === "POST") {
    let username = "";
    let password = "";

    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        const body = await request.json();
        username = (body.username || "").trim();
        password = (body.password || "").trim();
      } catch (e) {}
    } else {
      try {
        const form = await request.formData();
        username = (form.get("username") || "").trim();
        password = (form.get("password") || "").trim();
      } catch (e) {}
    }

    if (username === expectedUser && password === expectedPass) {
      const token = getAuthToken(expectedUser, expectedPass);
      const isHttps = request.url.startsWith("https");
      const cookieVal = `auth_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${isHttps ? "; Secure" : ""}`;

      if (contentType.includes("application/json")) {
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": cookieVal,
          },
        });
      }

      return new Response(null, {
        status: 302,
        headers: {
          Location: "/posts?format=html",
          "Set-Cookie": cookieVal,
        },
      });
    }

    // Invalid credentials
    if (contentType.includes("application/json")) {
      return new Response(JSON.stringify({ error: "Invalid username or password" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(renderLoginPage("Invalid username or password. Please try again."), {
      status: 401,
      headers: { "Content-Type": "text/html;charset=UTF-8" },
    });
  }

  return new Response("Method not allowed", { status: 405 });
}

/**
 * Handle Logout request (GET /logout)
 */
export function handleLogout(request) {
  const isHttps = request.url.startsWith("https");
  const clearCookie = `auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps ? "; Secure" : ""}`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/login",
      "Set-Cookie": clearCookie,
    },
  });
}
