const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || "dev-only-change-me";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "marketlink.sqlite");
const PUBLIC_DIR = path.join(__dirname, "public");
const ADMIN_USERNAME = "Emerson Sacama";
// Password is stored only as a scrypt hash, never as plaintext.
const ADMIN_PASSWORD_HASH = "scrypt$253759f1fb77e74025e385eb6d150c28$595a77f113ca343db3a431614f1389411171435fb3d59482f3b9f32ca340e623292273ef92107e7ba555d4de6f85d36dd44c819b19202beabe34484baa841433";

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS sellers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  name TEXT NOT NULL,
  price_usd INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  duration TEXT NOT NULL,
  currency TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS clicks (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  ip_hash TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  click_id TEXT REFERENCES clicks(id),
  buyer_name TEXT NOT NULL,
  gross_usd INTEGER NOT NULL,
  platform_fee_usd INTEGER NOT NULL DEFAULT 200,
  seller_net_usd INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payment_reference TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  type TEXT NOT NULL,
  amount_usd INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(order_id, type)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  username TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_campaign_seller ON campaigns(seller_id);
CREATE INDEX IF NOT EXISTS idx_click_campaign ON clicks(campaign_id);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_orders_campaign ON orders(campaign_id);
`);

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}
function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(data);
}
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("JSON inválido")); }
    });
    req.on("error", reject);
  });
}
function clean(v, max = 200) {
  return String(v ?? "").trim().slice(0, max);
}
function usdCents(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error("Valor USD inválido");
  return Math.round(n * 100);
}
function ipHash(req) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "";
  return crypto.createHash("sha256").update(ip).digest("hex");
}
function verifyPassword(password, encoded) {
  const [scheme, salt, storedHex] = String(encoded).split("$");
  if (scheme !== "scrypt" || !salt || !storedHex) return false;
  const derived = crypto.scryptSync(String(password), salt, 64);
  const stored = Buffer.from(storedHex, "hex");
  return stored.length === derived.length && crypto.timingSafeEqual(stored, derived);
}
function cookieToken(req) {
  const raw = req.headers.cookie || "";
  const match = raw.match(/(?:^|;\s*)ml_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}
function currentSession(req) {
  const token = cookieToken(req);
  if (!token) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const session = db.prepare("SELECT * FROM sessions WHERE token_hash=? AND expires_at>? ").get(tokenHash, Date.now());
  return session || null;
}
function requireAdmin(req, res) {
  const session = currentSession(req);
  if (!session || session.role !== "admin") {
    json(res, 401, {error:"Sessão ADM inválida ou expirada."});
    return null;
  }
  return session;
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath);
  const types = {".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8"};
  const type = types[ext] || "application/octet-stream";
  fs.readFile(filePath, (err, data) => {
    if (err) return json(res, 404, {error:"Ficheiro não encontrado"});
    res.writeHead(200, {"Content-Type":type, "X-Content-Type-Options":"nosniff"});
    res.end(data);
  });
}

const createCampaign = db.transaction((body) => {
  const sellerId = clean(body.sellerId, 80).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const sellerName = clean(body.sellerName);
  const productName = clean(body.productName);
  if (!sellerId || !sellerName || !productName) throw new Error("Vendedor, ID e produto são obrigatórios.");

  let seller = db.prepare("SELECT id FROM sellers WHERE id=?").get(sellerId);
  if (!seller) {
    db.prepare("INSERT INTO sellers(id,name) VALUES(?,?)").run(sellerId, sellerName);
  } else {
    db.prepare("UPDATE sellers SET name=? WHERE id=?").run(sellerName, sellerId);
  }

  // For this prototype, the campaign creates/uses a product owned by that seller.
  const existing = db.prepare("SELECT id FROM products WHERE seller_id=? AND name=? AND active=1").get(sellerId, productName);
  const productId = existing?.id || id("prd");
  if (!existing) {
    // Price is intentionally server-side; replace this with the seller's stored product price in production.
    db.prepare("INSERT INTO products(id,seller_id,name,price_usd) VALUES(?,?,?,?)")
      .run(productId, sellerId, productName, 990);
  }

  const campaignId = id("cmp");
  db.prepare(`
    INSERT INTO campaigns(id,seller_id,product_id,duration,currency,payment_method)
    VALUES(?,?,?,?,?,?)
  `).run(
    campaignId, sellerId, productId,
    clean(body.duration, 20),
    clean(body.currency, 10),
    clean(body.paymentMethod, 80)
  );

  return {campaignId, sellerId, productId};
});

function campaignDetails(campaignId) {
  return db.prepare(`
    SELECT c.id AS campaign_id, c.status, c.duration,
           s.id AS seller_id, s.name AS seller_name,
           p.id AS product_id, p.name AS product_name, p.price_usd
    FROM campaigns c
    JOIN sellers s ON s.id=c.seller_id
    JOIN products p ON p.id=c.product_id
    WHERE c.id=?
  `).get(campaignId);
}

const createOrder = db.transaction((body) => {
  const campaignId = clean(body.campaignId, 100);
  const productId = clean(body.productId, 100);
  const buyerName = clean(body.buyerName, 160);
  const c = campaignDetails(campaignId);
  if (!c || c.status !== "active") throw new Error("Campanha inválida ou inactiva.");
  if (c.product_id !== productId) throw new Error("Produto não pertence à campanha.");
  if (!buyerName) throw new Error("Nome do comprador é obrigatório.");

  // Click ID may be supplied by a future client session; the campaign/product relationship is revalidated here.
  const clickId = clean(body.clickId, 100) || null;
  if (clickId) {
    const click = db.prepare("SELECT id,campaign_id FROM clicks WHERE id=?").get(clickId);
    if (!click || click.campaign_id !== campaignId) throw new Error("Clique inválido.");
  }

  const gross = c.price_usd;
  const fee = 200; // US$2.00, represented in cents.
  if (gross < fee) throw new Error("O preço do produto é inferior à taxa mínima de US$2.");

  const orderId = id("ord");
  db.prepare(`
    INSERT INTO orders(id,seller_id,campaign_id,product_id,click_id,buyer_name,gross_usd,platform_fee_usd,seller_net_usd)
    VALUES(?,?,?,?,?,?,?,?,?)
  `).run(orderId,c.seller_id,campaignId,c.product_id,clickId,buyerName,gross,fee,gross-fee);

  return {orderId, grossUsd:gross/100, platformFeeUsd:fee/100, sellerNetUsd:(gross-fee)/100};
});

// Payment confirmation is deliberately separated from order creation.
// In production, only a verified provider webhook should call this path.
const confirmPayment = db.transaction((orderId, paymentReference) => {
  const order = db.prepare("SELECT * FROM orders WHERE id=?").get(orderId);
  if (!order) throw new Error("Pedido não encontrado.");
  if (order.status === "paid") return order;

  db.prepare(`
    UPDATE orders
    SET status='paid', payment_reference=?, paid_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='pending'
  `).run(paymentReference, orderId);

  const updated = db.prepare("SELECT * FROM orders WHERE id=?").get(orderId);
  if (updated.status !== "paid") throw new Error("Não foi possível confirmar o pagamento.");

  // Ledger entries are idempotent through UNIQUE(order_id,type).
  db.prepare(`
    INSERT OR IGNORE INTO ledger(id,seller_id,order_id,type,amount_usd)
    VALUES(?,?,?,?,?)
  `).run(id("led"), updated.seller_id, orderId, "seller_credit", updated.seller_net_usd);

  db.prepare(`
    INSERT OR IGNORE INTO ledger(id,seller_id,order_id,type,amount_usd)
    VALUES(?,?,?,?,?)
  `).run(id("led"), updated.seller_id, orderId, "platform_fee", updated.platform_fee_usd);

  return updated;
});

async function route(req, res) {
  const url = new URL(req.url, PUBLIC_BASE_URL);
  const pathname = url.pathname;

  if (req.method === "POST" && pathname === "/api/auth/login") {
    try {
      const body = await parseBody(req);
      const username = clean(body.username, 120);
      const password = String(body.password ?? "");
      const role = clean(body.role, 20);
      if (role !== "admin" || username.toLowerCase() !== ADMIN_USERNAME.toLowerCase() || !verifyPassword(password, ADMIN_PASSWORD_HASH)) {
        return json(res, 401, {error:"Utilizador ou palavra-passe incorrectos."});
      }
      const token = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
      db.prepare("INSERT INTO sessions(id,role,username,token_hash,expires_at) VALUES(?,?,?,?,?)")
        .run(id("ses"), "admin", ADMIN_USERNAME, tokenHash, expiresAt);
      res.writeHead(200, {
        "Content-Type":"application/json; charset=utf-8",
        "Cache-Control":"no-store",
        "Set-Cookie":`ml_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
        "X-Content-Type-Options":"nosniff"
      });
      return res.end(JSON.stringify({ok:true,role:"admin",username:ADMIN_USERNAME}));
    } catch(e) {
      return json(res,400,{error:e.message});
    }
  }

  if (req.method === "POST" && pathname === "/api/auth/logout") {
    const token = cookieToken(req);
    if (token) {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash);
    }
    res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Set-Cookie":"ml_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0","X-Content-Type-Options":"nosniff"});
    return res.end(JSON.stringify({ok:true}));
  }

  if (req.method === "GET" && pathname === "/api/auth/me") {
    const session = currentSession(req);
    return json(res,200,session ? {authenticated:true,role:session.role,username:session.username} : {authenticated:false});
  }

  if (req.method === "GET" && pathname === "/health") {
    return json(res, 200, {ok:true, service:"marketlink", database:"sqlite"});
  }

  // Public campaign redirect: records click server-side before redirecting to the storefront.
  if (req.method === "GET" && pathname.startsWith("/r/")) {
    const campaignId = pathname.slice(3);
    const c = campaignDetails(campaignId);
    if (!c || c.status !== "active") return json(res, 404, {error:"Campanha não encontrada."});

    const clickId = id("clk");
    db.prepare("INSERT INTO clicks(id,campaign_id,ip_hash,user_agent) VALUES(?,?,?,?)")
      .run(clickId, campaignId, ipHash(req), clean(req.headers["user-agent"], 500));

    res.writeHead(302, {
      Location: `/?campaign=${encodeURIComponent(campaignId)}&click=${encodeURIComponent(clickId)}`
    });
    return res.end();
  }

  if (req.method === "GET" && pathname.startsWith("/api/campaigns/")) {
    const campaignId = pathname.split("/").pop();
    const c = campaignDetails(campaignId);
    if (!c) return json(res,404,{error:"Campanha não encontrada."});
    return json(res,200,{
      campaign:{id:c.campaign_id,status:c.status,duration:c.duration},
      seller:{id:c.seller_id,name:c.seller_name},
      product:{id:c.product_id,name:c.product_name,priceUsd:c.price_usd/100}
    });
  }

  if (req.method === "POST" && pathname === "/api/campaigns") {
    try {
      const result = createCampaign(await parseBody(req));
      return json(res,201,{
        ...result,
        campaignUrl:`${PUBLIC_BASE_URL}/r/${result.campaignId}`
      });
    } catch(e) {
      return json(res,400,{error:e.message});
    }
  }

  if (req.method === "POST" && pathname === "/api/orders") {
    try {
      const body = await parseBody(req);
      // If the browser supplies a click ID, enforce that it belongs to the same campaign.
      const result = createOrder(body);
      return json(res,201,result);
    } catch(e) {
      return json(res,400,{error:e.message});
    }
  }

  if (req.method === "POST" && pathname === "/api/payments/webhook") {
    const secret = req.headers["x-marketlink-webhook-secret"];
    if (!secret || !crypto.timingSafeEqual(
      Buffer.from(String(secret)),
      Buffer.from(String(PAYMENT_WEBHOOK_SECRET))
    )) {
      return json(res,401,{error:"Webhook não autorizado."});
    }
    try {
      const body = await parseBody(req);
      const paymentReference = clean(body.paymentReference, 160);
      const orderId = clean(body.orderId, 100);
      if (!paymentReference || !orderId) throw new Error("orderId e paymentReference são obrigatórios.");
      const order = confirmPayment(orderId,paymentReference);
      return json(res,200,{
        ok:true,
        orderId:order.id,
        status:order.status,
        platformFeeUsd:order.platform_fee_usd/100,
        sellerNetUsd:order.seller_net_usd/100
      });
    } catch(e) {
      return json(res,400,{error:e.message});
    }
  }

  if (req.method === "GET" && pathname.startsWith("/api/sellers/") && pathname.endsWith("/wallet")) {
    const sellerId = decodeURIComponent(pathname.split("/")[3] || "");
    const seller = db.prepare("SELECT id,name FROM sellers WHERE id=?").get(sellerId);
    if (!seller) return json(res,404,{error:"Vendedor não encontrado."});
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type='seller_credit' THEN amount_usd ELSE 0 END),0) AS credits,
        COALESCE(SUM(CASE WHEN type='seller_debit' THEN amount_usd ELSE 0 END),0) AS debits
      FROM ledger WHERE seller_id=?
    `).get(sellerId);
    const fees = db.prepare(`
      SELECT COALESCE(SUM(platform_fee_usd),0) AS total
      FROM orders WHERE seller_id=? AND status='paid'
    `).get(sellerId);
    return json(res,200,{
      seller,
      balanceUsd:(row.credits-row.debits)/100,
      platformFeesUsd:fees.total/100
    });
  }

  if (req.method === "GET") {
    const safe = pathname === "/" ? "/index.html" : pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, safe));
    if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return sendFile(res,file);
    }
    return sendFile(res,path.join(PUBLIC_DIR,"index.html"));
  }

  return json(res,405,{error:"Método não permitido."});
}

const server = http.createServer((req,res) => {
  route(req,res).catch(err => {
    console.error(err);
    json(res,500,{error:"Erro interno do servidor."});
  });
});

server.listen(PORT, () => {
  console.log(`MarketLink profissional: ${PUBLIC_BASE_URL}`);
  console.log(`DB: ${DB_PATH}`);
});
