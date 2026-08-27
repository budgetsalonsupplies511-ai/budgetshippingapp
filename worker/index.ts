/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
  CALLBACK_SECRET: string;
  SHOPIFY_API_SECRET?: string;
  CONFIG_ENCRYPTION_KEY?: string;
  ORIGIN_POSTCODE: string;
  AUSPOST_API_KEY?: string;
  AUSPOST_ENABLED?: string;
  ARAMEX_ENABLED?: string;
  ARAMEX_API_URL?: string;
  ARAMEX_USERNAME?: string;
  ARAMEX_PASSWORD?: string;
  ARAMEX_ACCOUNT_NUMBER?: string;
  ARAMEX_ACCOUNT_PIN?: string;
  ARAMEX_ACCOUNT_ENTITY?: string;
  TNT_ENABLED?: string;
  TNT_API_URL?: string;
  TNT_API_TOKEN?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "Budget Multi-Carrier Shipping" });
    }

    if (url.pathname === "/api/settings") {
      return handleSettings(request, env);
    }

    if (url.pathname === "/api/test-carrier" && request.method === "POST") {
      return handleCarrierTest(request, env);
    }

    if (url.pathname === "/api/connect-shopify" && request.method === "POST") {
      return handleShopifyConnect(request, env);
    }

    if (request.method === "POST" && url.pathname === `/rates/${env.CALLBACK_SECRET}`) {
      try {
        const payload = await request.json() as any;
        const rate = payload?.rate;
        if (!rate?.destination?.postal_code || !Array.isArray(rate.items)) return Response.json({ rates: [] });
        const tags = (Array.isArray(rate.customer?.tags) ? rate.customer.tags : String(rate.customer?.tags || "").split(","))
          .map((tag: unknown) => String(tag).trim().toUpperCase());
        const itemTotal = rate.items.reduce((sum: number, item: any) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
        const total = Number(rate.order_totals?.total_price ?? itemTotal);
        const isTrade = tags.some((tag: string) => tag === "TRADE" || tag === "FREELANCE");
        const stored = await loadSettingsForShop(env, "buwngz-kc.myshopify.com");
        const state = normalizeAustralianState(rate.destination.province_code || rate.destination.province || "");
        const bulkyVariants = new Set((JSON.parse(stored.bulkyVariantIds || "[]") as string[]).map(normalizeShopifyId));
        const bulkyProducts = new Set((JSON.parse(stored.bulkyProducts || "[]") as Array<{id?:string}>).map(product=>normalizeShopifyId(product.id)).filter(Boolean));
        const hasBulky = rate.items.some((item:any)=>bulkyVariants.has(normalizeShopifyId(item.variant_id || item.variantId)) || bulkyProducts.has(normalizeShopifyId(item.product_id || item.productId)));
        const retailSettings = parseRetailSettings(stored.retailSettings);
        const chosenRule = hasBulky ? retailSettings.bulkyRule : (retailSettings.states[state] || retailSettings.defaultRule);
        const needsLiveRate = isTrade || chosenRule.mode === "live";
        if (!needsLiveRate) {
          const free = chosenRule.freeThreshold > 0 && total >= chosenRule.freeThreshold * 100;
          return Response.json({ rates: [{service_name:free?"Free Standard Shipping":"Standard Shipping",service_code:free?"RETAIL_FREE":"RETAIL_STANDARD",total_price:String(free?0:Math.round(chosenRule.standard*100)),description:free?`Free shipping on orders of $${chosenRule.freeThreshold} or more`:"Retail standard shipping",currency:rate.currency||"AUD"},{service_name:"Express Shipping",service_code:"RETAIL_EXPRESS",total_price:String(Math.round(chosenRule.express*100)),description:"Retail express shipping",currency:rate.currency||"AUD"}] });
        }

        const weightKg = Math.max(0.001, rate.items.reduce((sum: number, item: any) => sum + Number(item.grams || 0) * Number(item.quantity || 0), 0) / 1000);
        const quotes = await Promise.allSettled([
          quoteAusPostContract(stored, rate.destination.postal_code, weightKg),
          quoteJsonCarrier("Aramex", env.ARAMEX_ENABLED, env.ARAMEX_API_URL, undefined, env, rate, weightKg),
          quoteJsonCarrier("TNT", env.TNT_ENABLED, env.TNT_API_URL, env.TNT_API_TOKEN, env, rate, weightKg)
        ]);
        return Response.json({ rates: quotes.flatMap((q) => q.status === "fulfilled" ? q.value : []) });
      } catch (error) {
        console.error("rate callback failed", error);
        return Response.json({ rates: [] });
      }
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

async function quoteAusPost(env: Env, postcode: string, weight: number) {
  if (env.AUSPOST_ENABLED !== "true" || !env.AUSPOST_API_KEY) return [];
  const query = new URLSearchParams({ from_postcode: env.ORIGIN_POSTCODE, to_postcode: postcode, length: "30", width: "20", height: "15", weight: String(weight), service_code: "AUS_PARCEL_REGULAR" });
  const response = await fetch(`https://digitalapi.auspost.com.au/postage/parcel/domestic/calculate.json?${query}`, { headers: { "AUTH-KEY": env.AUSPOST_API_KEY } });
  if (!response.ok) throw new Error(`Australia Post ${response.status}`);
  const data: any = await response.json();
  const result = data?.postage_result;
  if (!result) return [];
  return [{ service_name: `Australia Post — ${result.service}`, service_code: "AUSPOST_REGULAR", total_price: String(Math.round(Number(result.total_cost) * 100)), description: result.delivery_time || "Australia Post live rate", currency: "AUD" }];
}

async function quoteJsonCarrier(name: string, enabled: string | undefined, apiUrl: string | undefined, token: string | undefined, env: Env, rate: any, weightKg: number) {
  if (enabled !== "true" || !apiUrl) return [];
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify({
    credentials: name === "Aramex" ? { username: env.ARAMEX_USERNAME, password: env.ARAMEX_PASSWORD, accountNumber: env.ARAMEX_ACCOUNT_NUMBER, accountPin: env.ARAMEX_ACCOUNT_PIN, accountEntity: env.ARAMEX_ACCOUNT_ENTITY } : undefined,
    origin: { countryCode: "AU", postalCode: env.ORIGIN_POSTCODE }, destination: { countryCode: rate.destination.country, postalCode: rate.destination.postal_code }, packages: [{ weightKg, length: 30, width: 20, height: 15 }]
  }) });
  if (!response.ok) throw new Error(`${name} ${response.status}`);
  const data: any = await response.json();
  const rows = data?.rates || [];
  return rows.map((row: any, index: number) => ({ service_name: `${name} — ${row.serviceName || "Delivery"}`, service_code: `${name.toUpperCase()}_${row.serviceCode || index}`, total_price: String(Math.round(Number(row.totalPrice) * 100)), description: row.description || `${name} live rate`, currency: row.currency || "AUD" })).filter((row: any) => Number.isFinite(Number(row.total_price)));
}

export default worker;

type StoredSettings = Record<string, string>;

async function loadSecureSettings(request: Request, env: Env): Promise<{shop:string;settings:StoredSettings}|Response> {
  if (!env.SHOPIFY_API_SECRET || !env.CONFIG_ENCRYPTION_KEY) return Response.json({ error: "Secure app setup is not complete." }, { status: 503 });
  const shop = await verifyShopifySession(request, env.SHOPIFY_API_SECRET);
  if (!shop || shop !== "buwngz-kc.myshopify.com") return Response.json({ error: "This Shopify session is not authorised." }, { status: 401 });
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS carrier_settings (shop TEXT PRIMARY KEY, encrypted_json TEXT NOT NULL, updated_at TEXT NOT NULL)").run();
  const row = await env.DB.prepare("SELECT encrypted_json FROM carrier_settings WHERE shop = ?").bind(shop).first<{encrypted_json:string}>();
  const settings = row?.encrypted_json ? await decryptSettings(row.encrypted_json, env.CONFIG_ENCRYPTION_KEY) : {};
  return { shop, settings };
}

async function handleCarrierTest(request: Request, env: Env): Promise<Response> {
  const loaded = await loadSecureSettings(request, env); if (loaded instanceof Response) return loaded;
  const { settings } = loaded;
  if (!settings.ausPostApiUrl || !settings.ausPostUsername || !settings.ausPostPassword || !settings.ausPostAccountNumber) return Response.json({ error: "Save all Australia Post credentials first." }, { status: 400 });
  const endpoint = `${settings.ausPostApiUrl.replace(/\/$/,"")}/shipping/v1/accounts/${encodeURIComponent(settings.ausPostAccountNumber)}`;
  try {
    const response = await fetch(endpoint, { headers: { accept:"application/json", "account-number":settings.ausPostAccountNumber, authorization:`Basic ${btoa(`${settings.ausPostUsername}:${settings.ausPostPassword}`)}` } });
    if (!response.ok) {
      let detail = ""; try { const data = await response.json() as any; detail = data?.errors?.[0]?.message || data?.message || ""; } catch {}
      return Response.json({ error: `Australia Post rejected the connection (${response.status})${detail?`: ${detail}`:"."}` }, { status: 400 });
    }
    return Response.json({ ok:true, message:"Australia Post connection successful. The charge account was recognised." });
  } catch { return Response.json({ error:"Could not reach the Australia Post API. Check the API URL." }, { status:400 }); }
}

async function loadSettingsForShop(env: Env, shop: string): Promise<StoredSettings> {
  if (!env.CONFIG_ENCRYPTION_KEY) return {};
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS carrier_settings (shop TEXT PRIMARY KEY, encrypted_json TEXT NOT NULL, updated_at TEXT NOT NULL)").run();
  const row = await env.DB.prepare("SELECT encrypted_json FROM carrier_settings WHERE shop = ?").bind(shop).first<{encrypted_json:string}>();
  return row?.encrypted_json ? decryptSettings(row.encrypted_json, env.CONFIG_ENCRYPTION_KEY) : {};
}

function parseRetailSettings(raw?:string){const base={mode:"flat",standard:10,express:20,freeThreshold:100};const states=Object.fromEntries(["NSW","VIC","QLD","SA","WA","NT","TAS","ACT"].map(s=>[s,{...base,mode:s==="WA"||s==="NT"?"live":"flat"}]));try{const p=raw?JSON.parse(raw):{};return{defaultRule:{...base,...p.defaultRule},bulkyRule:{...base,mode:"live",...p.bulkyRule},states:{...states,...p.states}}}catch{return{defaultRule:base,bulkyRule:{...base,mode:"live"},states}}}
function normalizeAustralianState(value:unknown){const state=String(value||"").trim().toUpperCase();const names:Record<string,string>={"NEW SOUTH WALES":"NSW","VICTORIA":"VIC","QUEENSLAND":"QLD","SOUTH AUSTRALIA":"SA","WESTERN AUSTRALIA":"WA","NORTHERN TERRITORY":"NT","TASMANIA":"TAS","AUSTRALIAN CAPITAL TERRITORY":"ACT"};return names[state]||state}
function normalizeShopifyId(value:unknown){const id=String(value||"").trim();return id.includes("/")?id.slice(id.lastIndexOf("/")+1):id}

async function quoteAusPostContract(settings: StoredSettings, postcode: string, weight: number) {
  if (!settings.ausPostApiUrl || !settings.ausPostUsername || !settings.ausPostPassword || !settings.ausPostAccountNumber || !settings.originPostcode) return [];
  const endpoint = `${settings.ausPostApiUrl.replace(/\/$/,"")}/shipping/v1/prices/items`;
  const response = await fetch(endpoint, { method:"POST", headers:{ "content-type":"application/json", accept:"application/json", "account-number":settings.ausPostAccountNumber, authorization:`Basic ${btoa(`${settings.ausPostUsername}:${settings.ausPostPassword}`)}` }, body:JSON.stringify({ from:{postcode:settings.originPostcode}, to:{postcode}, items:[{item_reference:"shopify-rate",length:30,width:20,height:15,weight:Number(weight.toFixed(3))}] }) });
  const data = await response.json() as any;
  if (!response.ok) throw new Error(data?.errors?.[0]?.message || `Australia Post ${response.status}`);
  const prices = data?.items?.[0]?.prices || [];
  return prices.map((price:any)=>({service_name:`Australia Post — ${price.product_type}`,service_code:`AUSPOST_${price.product_id}`,total_price:String(Math.round(Number(price.calculated_price)*100)),description:"Australia Post live contract rate",currency:"AUD"})).filter((row:any)=>Number.isFinite(Number(row.total_price)));
}

async function handleShopifyConnect(request: Request, env: Env): Promise<Response> {
  if (!env.SHOPIFY_API_SECRET) return Response.json({error:"Shopify security setup is incomplete."},{status:503});
  const sessionToken=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"");
  const shop=await verifyShopifySession(request,env.SHOPIFY_API_SECRET);
  if (!sessionToken || shop!=="buwngz-kc.myshopify.com") return Response.json({error:"Unauthorised Shopify session."},{status:401});
  const settings=await loadSettingsForShop(env,shop);
  const sample=await quoteAusPostContract(settings,"3000",1);
  if (!sample.length) return Response.json({error:"Australia Post returned no rates for the test parcel. Shopify was not connected."},{status:400});
  const tokenResponse=await fetch(`https://${shop}/admin/oauth/access_token`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({client_id:"fb443e17162b106d7c2c0c546f9a447e",client_secret:env.SHOPIFY_API_SECRET,grant_type:"urn:ietf:params:oauth:grant-type:token-exchange",subject_token:sessionToken,subject_token_type:"urn:ietf:params:oauth:token-type:id_token",requested_token_type:"urn:shopify:params:oauth:token-type:offline-access-token"})});
  const tokenData=await tokenResponse.json() as any;if(!tokenResponse.ok||!tokenData.access_token)return Response.json({error:"Shopify access-token exchange failed."},{status:400});
  const callbackUrl=`${new URL(request.url).origin}/rates/${env.CALLBACK_SECRET}`;
  const gql=await fetch(`https://${shop}/admin/api/2026-07/graphql.json`,{method:"POST",headers:{"content-type":"application/json","x-shopify-access-token":tokenData.access_token},body:JSON.stringify({query:`mutation CreateCarrier($input: DeliveryCarrierServiceCreateInput!) { carrierServiceCreate(input: $input) { carrierService { id name active callbackUrl } userErrors { field message } } }`,variables:{input:{name:"Budget Multi-Carrier Shipping",callbackUrl,active:true,supportsServiceDiscovery:true}}})});
  const result=await gql.json() as any;const errors=result?.data?.carrierServiceCreate?.userErrors||result?.errors||[];if(errors.length)return Response.json({error:errors.map((e:any)=>e.message).join("; ")},{status:400});
  return Response.json({ok:true,message:`Connected to Shopify. Australia Post returned ${sample.length} test rate${sample.length===1?"":"s"}.`});
}

async function handleSettings(request: Request, env: Env): Promise<Response> {
  if (!env.SHOPIFY_API_SECRET || !env.CONFIG_ENCRYPTION_KEY) return Response.json({ error: "Secure app setup is not complete." }, { status: 503 });
  const shop = await verifyShopifySession(request, env.SHOPIFY_API_SECRET);
  if (!shop || shop !== "buwngz-kc.myshopify.com") return Response.json({ error: "This Shopify session is not authorised." }, { status: 401 });
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS carrier_settings (shop TEXT PRIMARY KEY, encrypted_json TEXT NOT NULL, updated_at TEXT NOT NULL)").run();
  const row = await env.DB.prepare("SELECT encrypted_json FROM carrier_settings WHERE shop = ?").bind(shop).first<{encrypted_json:string}>();
  let settings: StoredSettings = {};
  if (row?.encrypted_json) settings = await decryptSettings(row.encrypted_json, env.CONFIG_ENCRYPTION_KEY);

  if (request.method === "GET") return Response.json({
    ready: true,
    originPostcode: settings.originPostcode || "",
    australiaPost: Boolean(settings.ausPostApiUrl && settings.ausPostUsername && settings.ausPostPassword && settings.ausPostAccountNumber),
    aramex: Boolean(settings.aramexClientId && settings.aramexClientSecret),
    tnt: Boolean(settings.tntApiToken && settings.tntApiUrl),
    bulkyProducts: JSON.parse(settings.bulkyProducts || "[]"),
    retailSettings: parseRetailSettings(settings.retailSettings),
  });
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });

  const body = await request.json() as Record<string, string>;
  if (body.carrier === "Origin") {
    if (!/^\d{4}$/.test(body.originPostcode || "")) return Response.json({ error: "Enter a valid four-digit Australian postcode." }, { status: 400 });
    settings.originPostcode = body.originPostcode;
  } else if (body.carrier === "Australia Post") {
    for (const field of ["apiUrl","username","password","accountNumber"]) if (!body[field]) return Response.json({ error: `Australia Post ${field} is required.` }, { status: 400 });
    if (!/^\d{1,10}$/.test(body.accountNumber)) return Response.json({ error: "Enter a valid Australia Post charge account number." }, { status: 400 });
    let apiUrl: URL;
    try { apiUrl = new URL(body.apiUrl); } catch { return Response.json({ error: "Enter a valid Australia Post API URL." }, { status: 400 }); }
    if (apiUrl.protocol !== "https:") return Response.json({ error: "Australia Post API URL must use HTTPS." }, { status: 400 });
    Object.assign(settings, { ausPostApiUrl:apiUrl.origin, ausPostUsername:body.username, ausPostPassword:body.password, ausPostAccountNumber:body.accountNumber.padStart(10,"0") });
  } else if (body.carrier === "Aramex") {
    for (const field of ["clientName","clientId","description","clientSecret"]) if (!body[field]) return Response.json({ error: `Aramex ${field} is required.` }, { status: 400 });
    Object.assign(settings, { aramexClientName:body.clientName, aramexClientId:body.clientId, aramexDescription:body.description, aramexClientSecret:body.clientSecret });
  } else if (body.carrier === "TNT") {
    if (!body.apiUrl || !body.apiToken) return Response.json({ error: "TNT API URL and token are required." }, { status: 400 });
    Object.assign(settings, { tntApiUrl:body.apiUrl, tntApiToken:body.apiToken });
  } else if (body.carrier === "Bulky products") {
    const products = Array.isArray((body as any).products) ? (body as any).products : [];
    settings.bulkyProducts = JSON.stringify(products.map((p:any)=>({id:String(p.id),title:String(p.title)})));
    settings.bulkyVariantIds = JSON.stringify(products.flatMap((p:any)=>Array.isArray(p.variantIds)?p.variantIds.map((id:unknown)=>normalizeShopifyId(id)):[]));
  } else if (body.carrier === "Retail rules") {
    settings.retailSettings = JSON.stringify((body as any).retailSettings || {});
  } else return Response.json({ error: "Unknown carrier." }, { status: 400 });

  const encrypted = await encryptSettings(settings, env.CONFIG_ENCRYPTION_KEY);
  await env.DB.prepare("INSERT INTO carrier_settings (shop, encrypted_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(shop) DO UPDATE SET encrypted_json=excluded.encrypted_json, updated_at=excluded.updated_at").bind(shop, encrypted, new Date().toISOString()).run();
  return Response.json({ ok: true });
}

async function verifyShopifySession(request: Request, secret: string): Promise<string | null> {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const parts = token.split("."); if (parts.length !== 3) return null;
  const expected = await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!timingSafeEqual(new Uint8Array(expected), base64UrlDecode(parts[2]))) return null;
  const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]))) as { exp?:number; nbf?:number; dest?:string };
  const now = Math.floor(Date.now()/1000); if (!claims.exp || claims.exp < now || (claims.nbf && claims.nbf > now+5)) return null;
  try { return new URL(claims.dest || "").hostname.toLowerCase(); } catch { return null; }
}

function timingSafeEqual(a:Uint8Array,b:Uint8Array){if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0}
function base64UrlDecode(value:string){const normal=value.replace(/-/g,"+").replace(/_/g,"/");const raw=atob(normal.padEnd(Math.ceil(normal.length/4)*4,"="));return Uint8Array.from(raw,c=>c.charCodeAt(0))}
async function encryptionKey(secret:string){return crypto.subtle.importKey("raw",await crypto.subtle.digest("SHA-256",new TextEncoder().encode(secret)),{name:"AES-GCM"},false,["encrypt","decrypt"])}
async function encryptSettings(value:StoredSettings,secret:string){const iv=crypto.getRandomValues(new Uint8Array(12));const encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv},await encryptionKey(secret),new TextEncoder().encode(JSON.stringify(value)));return `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(encrypted)))}`}
async function decryptSettings(value:string,secret:string){const [iv,data]=value.split(".");const decrypted=await crypto.subtle.decrypt({name:"AES-GCM",iv:Uint8Array.from(atob(iv),c=>c.charCodeAt(0))},await encryptionKey(secret),Uint8Array.from(atob(data),c=>c.charCodeAt(0)));return JSON.parse(new TextDecoder().decode(decrypted)) as StoredSettings}
