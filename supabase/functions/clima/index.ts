// Radar do Clima — função única que busca, confere e junta previsões de várias fontes.
// Ações (parâmetro "acao"):
//   buscar   ?q=CEP ou nome da cidade        -> lista de locais
//   reverso  ?lat=&lon=                       -> nome do local (GPS)
//   previsao ?lat=&lon=&nome=&uf=             -> previsão combinada, alertas e campo
//   saude                                     -> estado das fontes e pesos
//   verificar / avisos / modelos (robôs, exigem cabeçalho x-cron)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SITE = "https://talles2026.github.io/radar-clima/";
const UA = "radar-clima/1.0 (+https://talles2026.github.io/radar-clima/)";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-cron",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const VERSAO = "2026.10.28-3";
const CACHE_MIN = 20;

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

type J = Record<string, any>;
const UFS: Record<string, string> = {
  "acre": "AC", "alagoas": "AL", "amapa": "AP", "amazonas": "AM", "bahia": "BA", "ceara": "CE", "distrito federal": "DF",
  "espirito santo": "ES", "goias": "GO", "maranhao": "MA", "mato grosso": "MT", "mato grosso do sul": "MS", "minas gerais": "MG",
  "para": "PA", "paraiba": "PB", "parana": "PR", "pernambuco": "PE", "piaui": "PI", "rio de janeiro": "RJ", "rio grande do norte": "RN",
  "rio grande do sul": "RS", "rondonia": "RO", "roraima": "RR", "santa catarina": "SC", "sao paulo": "SP", "sergipe": "SE", "tocantins": "TO",
};
const SIGLAS = new Set(Object.values(UFS));
const norm = (s: string) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const ufDe = (s: string) => { const n = norm(s); if (SIGLAS.has(n.toUpperCase()) && n.length === 2) return n.toUpperCase(); return UFS[n] || ""; };
const r1 = (v: number | null | undefined) => (v == null || !isFinite(v) ? null : Math.round(v * 10) / 10);
const r0 = (v: number | null | undefined) => (v == null || !isFinite(v) ? null : Math.round(v));
const resp = (d: unknown, status = 200, extra: J = {}) =>
  new Response(JSON.stringify(d), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", ...extra } });

// ---------------------------------------------------------------- fontes e saúde
let FONTES: Record<string, J> = {};
let fontesEm = 0;
async function fontes() {
  if (Date.now() - fontesEm < 5 * 60e3 && Object.keys(FONTES).length) return FONTES;
  const { data } = await db.from("fontes").select("id,ativo,config");
  if (data?.length) { FONTES = Object.fromEntries(data.map((f: J) => [f.id, f])); fontesEm = Date.now(); }
  if (Date.now() - syncEm > 30 * 60e3) { syncEm = Date.now(); sincronizarConfig().catch(() => {}); }
  return FONTES;
}
// Configuração das fontes publicada no GitHub (o robô de manutenção edita config/fontes.json
// para trocar endereços ou desligar uma fonte, sem precisar reimplantar esta função).
let syncEm = 0;
const CONFIG_URL = "https://raw.githubusercontent.com/talles2026/radar-clima/main/config/fontes.json";
async function sincronizarConfig() {
  const r = await fetch(CONFIG_URL + "?t=" + Date.now(), { signal: AbortSignal.timeout(6000) });
  if (!r.ok) return { ok: false, erro: `HTTP ${r.status}` };
  const j = await r.json();
  const { data: v } = await db.from("estado").select("valor").eq("chave", "config_versao").maybeSingle();
  if (!j?.versao || !Array.isArray(j.fontes) || +j.versao <= +(v?.valor ?? 0)) return { ok: true, mudou: false };
  const linhas = j.fontes.filter((f: J) => f?.id && f?.config && typeof f.config === "object")
    .map((f: J) => ({ id: String(f.id), nome: String(f.nome || f.id), tipo: String(f.tipo || "previsao"), ativo: f.ativo !== false, config: f.config, atualizado: new Date().toISOString() }));
  if (!linhas.length) return { ok: false, erro: "arquivo sem fontes" };
  await db.from("fontes").upsert(linhas);
  await db.from("estado").upsert({ chave: "config_versao", valor: String(j.versao) });
  await db.from("manutencao").insert({ quem: "configuração", resumo: j.nota ? String(j.nota).slice(0, 300) : `Configuração das fontes atualizada (versão ${j.versao}).` });
  fontesEm = 0;
  return { ok: true, mudou: true, versao: j.versao };
}
const cfg = (id: string) => FONTES[id]?.config ?? {};
const ativa = (id: string) => FONTES[id] ? FONTES[id].ativo !== false : true;
const saudeRodada: J[] = [];
function registrar(id: string, ok: boolean, ms: number, erro = "") {
  saudeRodada.push({ id, ok, ms, erro });
  db.rpc("registrar_fonte", { p_id: id, p_ok: ok, p_ms: Math.round(ms), p_erro: erro }).then(() => {}, () => {});
}

async function pegar(id: string, url: string, tipo: "json" | "texto" | "latin1" = "json", ms = 9000, headers: J = {}) {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: tipo === "json" ? "application/json" : "*/*", ...headers }, signal: AbortSignal.timeout(ms) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    let out: any;
    if (tipo === "json") out = await r.json();
    else if (tipo === "latin1") out = new TextDecoder("iso-8859-1").decode(await r.arrayBuffer());
    else out = await r.text();
    registrar(id, true, performance.now() - t0);
    return out;
  } catch (e: any) {
    registrar(id, false, performance.now() - t0, String(e?.message ?? e));
    throw e;
  }
}
// tenta, e se o dado vier vazio/estranho também conta como falha
async function pegarValido<T>(id: string, fn: () => Promise<T>, valido: (x: T) => boolean): Promise<T | null> {
  if (!ativa(id)) return null;
  try { const x = await fn(); if (valido(x)) return x; registrar(id, false, 0, "resposta sem dados válidos"); } catch (_) { /* já registrado */ }
  return null;
}

// ---------------------------------------------------------------- localização
type Local = { nome: string; uf: string; lat: number; lon: number; detalhe?: string; pop?: number; cep?: string };

async function porCidade(q: string): Promise<Local[]> {
  let nome = q.trim(), uf = "";
  const m = nome.match(/^(.*?)[\s,\-\/]+([A-Za-z]{2}|[A-Za-zÀ-ú ]{4,})$/);
  if (m && ufDe(m[2])) { nome = m[1].trim(); uf = ufDe(m[2]); }
  const om = cfg("om_geo").url || "https://geocoding-api.open-meteo.com/v1/search";
  const a = await pegarValido("om_geo", () => pegar("om_geo", `${om}?name=${encodeURIComponent(nome)}&count=15&language=pt&countryCode=BR&format=json`),
    (j: J) => Array.isArray(j?.results) || j?.generationtime_ms != null);
  let lista: Local[] = (a?.results ?? []).filter((x: J) => x.country_code === "BR").map((x: J) => ({
    nome: x.name, uf: ufDe(x.admin1 || ""), lat: x.latitude, lon: x.longitude, pop: x.population || 0,
    detalhe: x.admin2 && norm(x.admin2) !== norm(x.name) ? `município de ${x.admin2}` : (x.feature_code?.startsWith("PPLA") || x.feature_code === "PPLC" ? "" : ""),
  }));
  if (!lista.length) {
    const nb = cfg("nominatim").url || "https://nominatim.openstreetmap.org";
    const b = await pegarValido("nominatim", () => pegar("nominatim", `${nb}/search?q=${encodeURIComponent(nome + (uf ? ", " + uf : ""))}&countrycodes=br&format=jsonv2&addressdetails=1&limit=10&accept-language=pt-BR`),
      (j: any) => Array.isArray(j));
    lista = (b ?? []).map((x: J) => {
      const ad = x.address || {};
      return { nome: ad.city || ad.town || ad.village || ad.municipality || x.name, uf: (ad["ISO3166-2-lvl4"] || "").slice(3) || ufDe(ad.state || ""),
        lat: +x.lat, lon: +x.lon, pop: 0, detalhe: ad.suburb || "" };
    });
  }
  if (uf) { const f = lista.filter(l => l.uf === uf); if (f.length) lista = f; }
  // nome exato primeiro, depois população
  const alvo = norm(nome);
  lista.sort((x, y) => (+(norm(y.nome) === alvo) - +(norm(x.nome) === alvo)) || ((y.pop || 0) - (x.pop || 0)));
  const vistos = new Set<string>();
  return lista.filter(l => { const k = norm(l.nome) + l.uf; if (vistos.has(k)) return false; vistos.add(k); return true; }).slice(0, 8);
}

async function porCep(cep: string): Promise<Local[]> {
  const fmt = cep.slice(0, 5) + "-" + cep.slice(5);
  // 1) BrasilAPI (às vezes já vem com coordenadas)
  const b = await pegarValido("brasilapi", () => pegar("brasilapi", (cfg("brasilapi").url || "https://brasilapi.com.br/api/cep/v2/{cep}").replace("{cep}", cep)),
    (j: J) => !!j?.city && !!j?.state);
  let cidade = b?.city, uf = b?.state, bairro = b?.neighborhood || "", rua = b?.street || "";
  const co = b?.location?.coordinates;
  if (co && +co.latitude && +co.longitude && Math.abs(+co.latitude) < 35) {
    return [{ nome: cidade, uf, lat: +co.latitude, lon: +co.longitude, cep: fmt, detalhe: [rua, bairro].filter(Boolean).join(", ") }];
  }
  // 2) ViaCEP
  if (!cidade) {
    const v = await pegarValido("viacep", () => pegar("viacep", (cfg("viacep").url || "https://viacep.com.br/ws/{cep}/json/").replace("{cep}", cep)),
      (j: J) => !!j?.localidade);
    if (v) { cidade = v.localidade; uf = v.uf; bairro = v.bairro || ""; rua = v.logradouro || ""; }
  }
  // 3) AwesomeAPI (traz coordenadas)
  if (!cidade) {
    const w = await pegarValido("awesomeapi", () => pegar("awesomeapi", (cfg("awesomeapi").url || "https://cep.awesomeapi.com.br/json/{cep}").replace("{cep}", cep)),
      (j: J) => !!j?.city && !!j?.lat);
    if (w) return [{ nome: w.city, uf: w.state, lat: +w.lat, lon: +w.lng, cep: fmt, detalhe: [w.address, w.district].filter(Boolean).join(", ") }];
  }
  if (!cidade) return [];
  const c = (await porCidade(`${cidade} ${uf}`))[0];
  if (!c) return [];
  return [{ ...c, nome: cidade, uf, cep: fmt, detalhe: [rua, bairro].filter(Boolean).join(", ") }];
}

async function reverso(lat: number, lon: number): Promise<Local> {
  const nb = cfg("nominatim").url || "https://nominatim.openstreetmap.org";
  const n = await pegarValido("nominatim", () => pegar("nominatim", `${nb}/reverse?lat=${lat}&lon=${lon}&format=jsonv2&zoom=10&accept-language=pt-BR`),
    (j: J) => !!j?.address);
  if (n) {
    const ad = n.address;
    return { nome: ad.city || ad.town || ad.village || ad.municipality || ad.county || n.name || "Local atual", uf: (ad["ISO3166-2-lvl4"] || "").slice(3) || ufDe(ad.state || ""), lat, lon };
  }
  try {
    const g = await pegar("nominatim", `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=pt`);
    if (g?.city || g?.locality) return { nome: g.city || g.locality, uf: (g.principalSubdivisionCode || "").slice(3) || ufDe(g.principalSubdivision || ""), lat, lon };
  } catch (_) { /* segue */ }
  return { nome: "Local atual", uf: "", lat, lon };
}

// ---------------------------------------------------------------- previsões brutas
const DIAS = 8;
const VARS_H = "temperature_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m,relative_humidity_2m";
const VARS_D = "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code,wind_speed_10m_max,wind_gusts_10m_max";

// separa as chaves "variavel_modelo" do Open-Meteo de forma tolerante
function porModelo(bloco: J, vars: string[], modelos: string[]) {
  const out: Record<string, J> = {};
  if (!bloco) return out;
  for (const m of modelos) {
    const o: J = {}; let cheio = false;
    for (const v of vars) {
      const arr = bloco[`${v}_${m}`] ?? (modelos.length === 1 ? bloco[v] : undefined);
      if (Array.isArray(arr)) { o[v] = arr; if (arr.some((x: any) => x != null)) cheio = true; }
    }
    if (cheio) out[m] = o;
  }
  return out;
}

async function openMeteo(lat: number, lon: number) {
  const c = cfg("openmeteo");
  const url = c.url || "https://api.open-meteo.com/v1/forecast";
  const modelos: string[] = c.modelos || ["ecmwf_ifs025", "icon_seamless", "gfs_seamless"];
  const q = `latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=${DIAS}`;
  const [multi, base] = await Promise.all([
    pegarValido("openmeteo", () => pegar("openmeteo", `${url}?${q}&hourly=${VARS_H}&daily=${VARS_D}&models=${modelos.join(",")}`, "json", 12000),
      (j: J) => Array.isArray(j?.daily?.time) && j.daily.time.length >= 5),
    pegarValido("openmeteo", () => pegar("openmeteo", `${url}?${q}&models=best_match` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m,wind_direction_10m,is_day` +
      `&hourly=${VARS_H},apparent_temperature,precipitation_probability,uv_index,is_day,wind_direction_10m,dew_point_2m` +
      `&daily=${VARS_D},precipitation_probability_max,uv_index_max,sunrise,sunset`, "json", 10000),
      (j: J) => Array.isArray(j?.hourly?.time) && j.hourly.time.length >= 72),
  ]);
  const dm = multi ? porModelo(multi.daily, VARS_D.split(","), modelos) : {};
  const hm = multi ? porModelo(multi.hourly, VARS_H.split(","), modelos) : {};
  const vazios = modelos.filter(m => !dm[m]);
  if (multi && vazios.length) {
    // modelo deixou de responder: registra para o robô trocar por um equivalente
    db.from("estado").upsert({ chave: "modelos_vazios", valor: JSON.stringify({ quando: new Date().toISOString(), modelos: vazios }) }).then(() => {}, () => {});
  }
  // reserva: se a chamada de vários modelos falhar, usa a combinação padrão do Open-Meteo como um modelo
  if (!Object.keys(dm).length && base) {
    dm["best_match"] = base.daily; hm["best_match"] = base.hourly;
  }
  return { base, dm, hm, tz: (multi || base)?.timezone, off: (multi || base)?.utc_offset_seconds ?? -10800, elev: (multi || base)?.elevation, diasT: (multi?.daily?.time || base?.daily?.time || []) as string[], horasT: (multi?.hourly?.time || base?.hourly?.time || []) as string[] };
}

async function ensemble(lat: number, lon: number) {
  const c = cfg("openmeteo_ens");
  const url = c.url || "https://ensemble-api.open-meteo.com/v1/ensemble";
  const modelos: string[] = c.modelos || ["ecmwf_ifs025", "gfs025"];
  const j = await pegarValido("openmeteo_ens", () => pegar("openmeteo_ens",
    `${url}?latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=${DIAS}&daily=precipitation_sum&hourly=precipitation&models=${modelos.join(",")}`, "json", 12000),
    (j: J) => Array.isArray(j?.daily?.time));
  if (!j) return null;
  // agrupa membros por conjunto: precipitation_sum[_memberNN]_<grupo>
  const agrupa = (bloco: J, v: string) => {
    const g: Record<string, number[][]> = {};
    for (const k of Object.keys(bloco || {})) {
      if (!k.startsWith(v)) continue;
      const grupo = k.slice(v.length).replace(/^_member\d+/, "").replace(/^_/, "") || "ens";
      (g[grupo] ||= []).push(bloco[k]);
    }
    return g;
  };
  return { dT: j.daily.time as string[], hT: j.hourly?.time as string[], d: agrupa(j.daily, "precipitation_sum"), h: agrupa(j.hourly, "precipitation") };
}

async function metno(lat: number, lon: number, off: number) {
  const url = cfg("metno").url || "https://api.met.no/weatherapi/locationforecast/2.0/compact";
  const j = await pegarValido("metno", () => pegar("metno", `${url}?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, "json", 9000),
    (j: J) => Array.isArray(j?.properties?.timeseries) && j.properties.timeseries.length > 24);
  if (!j) return null;
  const dias: Record<string, { tmax: number; tmin: number; chuva: number; n: number }> = {};
  for (const t of j.properties.timeseries) {
    const loc = new Date(Date.parse(t.time) + off * 1000).toISOString();
    const d = loc.slice(0, 10);
    const temp = t.data?.instant?.details?.air_temperature;
    if (temp == null) continue;
    const x = (dias[d] ||= { tmax: -99, tmin: 99, chuva: 0, n: 0 });
    x.tmax = Math.max(x.tmax, temp); x.tmin = Math.min(x.tmin, temp); x.n++;
    const p1 = t.data?.next_1_hours?.details?.precipitation_amount;
    if (p1 != null) x.chuva += p1;
    else if (t.data?.next_6_hours?.details?.precipitation_amount != null && /T(00|06|12|18)/.test(loc)) x.chuva += t.data.next_6_hours.details.precipitation_amount;
  }
  // só dias com cobertura suficiente (horário de 1h ou 6h)
  return Object.fromEntries(Object.entries(dias).filter(([, v]) => v.n >= 4));
}

const CPTEC_TEMPO: Record<string, string> = {
  ec: "Encoberto com chuvas isoladas", ci: "Chuvas isoladas", c: "Chuva", in: "Instável", pp: "Possibilidade de pancadas de chuva",
  cm: "Chuva pela manhã", cn: "Chuva à noite", pt: "Pancadas de chuva à tarde", pm: "Pancadas de chuva pela manhã", np: "Nublado e pancadas de chuva",
  pc: "Pancadas de chuva", pn: "Parcialmente nublado", cv: "Chuvisco", ch: "Chuvoso", t: "Tempestade", ps: "Predomínio de sol", e: "Encoberto",
  n: "Nublado", cl: "Céu claro", nv: "Nevoeiro", g: "Geada", ne: "Neve", nd: "Não definido", pnt: "Pancadas de chuva à noite",
  psc: "Possibilidade de chuva", pcm: "Possibilidade de chuva pela manhã", pct: "Possibilidade de chuva à tarde", pcn: "Possibilidade de chuva à noite",
  npt: "Nublado com pancadas à tarde", npn: "Nublado com pancadas à noite", ncn: "Nublado com possibilidade de chuva à noite",
  nct: "Nublado com possibilidade de chuva à tarde", ncm: "Nublado com possibilidade de chuva pela manhã", npm: "Nublado com pancadas pela manhã",
  npp: "Nublado com possibilidade de pancadas", vn: "Variação de nebulosidade", ct: "Chuva à tarde", ppn: "Possibilidade de pancadas à noite",
  ppt: "Possibilidade de pancadas à tarde", ppm: "Possibilidade de pancadas pela manhã",
};
async function cptec(nome: string, uf: string) {
  if (!nome || !uf || !ativa("cptec")) return null;
  const c = cfg("cptec");
  const chave = `cptec:${norm(nome)}-${uf}`;
  let id = (await db.from("estado").select("valor").eq("chave", chave).maybeSingle()).data?.valor;
  try {
    if (!id) {
      const xml = await pegar("cptec", (c.lista || "http://servicos.cptec.inpe.br/XML/listaCidades?city=") + encodeURIComponent(norm(nome)), "latin1", 7000);
      const achados = [...xml.matchAll(/<cidade><nome>(.*?)<\/nome><uf>(\w\w)<\/uf><id>(\d+)<\/id><\/cidade>/g)];
      const m = achados.find(a => a[2] === uf && norm(a[1]) === norm(nome)) || achados.find(a => a[2] === uf);
      if (!m) return null;
      id = m[3];
      await db.from("estado").upsert({ chave, valor: id });
    }
    const xml = await pegar("cptec", (c.previsao || "http://servicos.cptec.inpe.br/XML/cidade/7dias/{id}/previsao.xml").replace("{id}", id), "latin1", 7000);
    const out: Record<string, J> = {};
    for (const p of xml.matchAll(/<previsao>\s*<dia>([\d-]+)<\/dia>\s*<tempo>(\w+)<\/tempo>\s*<maxima>(-?\d+)<\/maxima>\s*<minima>(-?\d+)<\/minima>/g)) {
      out[p[1]] = { tempo: CPTEC_TEMPO[p[2]] || p[2], sigla: p[2], tmax: +p[3], tmin: +p[4] };
    }
    if (!Object.keys(out).length) { registrar("cptec", false, 0, "formato do XML mudou"); return null; }
    return out;
  } catch (_) { return null; }
}

let INMET: { em: number; itens: J[] } = { em: 0, itens: [] };
async function inmet() {
  if (Date.now() - INMET.em < 10 * 60e3) return INMET.itens;
  const { data: c } = await db.from("cache").select("dados,criado").eq("chave", "inmet").maybeSingle();
  if (c && Date.now() - Date.parse(c.criado) < 15 * 60e3) { INMET = { em: Date.now(), itens: c.dados }; return c.dados; }
  const j = await pegarValido("inmet", () => pegar("inmet", cfg("inmet").url || "https://apiprevmet3.inmet.gov.br/avisos/ativos", "json", 12000),
    (j: J) => Array.isArray(j?.hoje) || Array.isArray(j?.futuro));
  if (!j) return c?.dados ?? [];
  const itens = [...(j.hoje || []), ...(j.futuro || [])].map((a: J) => {
    let pol: any = null; try { pol = typeof a.poligono === "string" ? JSON.parse(a.poligono) : a.poligono; } catch (_) { /* sem polígono */ }
    return { id: a.id_aviso ?? a.id, descricao: a.descricao, severidade: a.severidade, cor: a.aviso_cor, inicio: a.inicio || a.data_inicio, fim: a.fim || a.data_fim,
      riscos: a.riscos || [], instrucoes: a.instrucoes || [], geocodes: String(a.geocodes || ""), poligono: pol };
  });
  await db.from("cache").upsert({ chave: "inmet", dados: itens, criado: new Date().toISOString() });
  INMET = { em: Date.now(), itens };
  return itens;
}
function dentro(lon: number, lat: number, anel: number[][]) {
  let ok = false;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [xi, yi] = anel[i], [xj, yj] = anel[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) ok = !ok;
  }
  return ok;
}
function noPoligono(lat: number, lon: number, g: J | null) {
  if (!g) return false;
  const pols = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  return pols.some((p: number[][][]) => p?.[0] && dentro(lon, lat, p[0]));
}

// ---------------------------------------------------------------- pesos
async function pesos(lat: number, lon: number) {
  const reg = `${Math.round(lat / 2) * 2},${Math.round(lon / 2) * 2}`;
  const { data } = await db.from("pesos").select("regiao,modelo,variavel,peso,amostras").in("regiao", ["global", reg]);
  const P: Record<string, Record<string, number>> = { tmax: {}, tmin: {}, chuva: {} };
  for (const x of (data ?? []).filter((x: J) => x.regiao === "global")) (P[x.variavel] ||= {})[x.modelo] = x.peso;
  let aprendido = false;
  for (const x of (data ?? []).filter((x: J) => x.regiao === reg && x.amostras >= 10)) { (P[x.variavel] ||= {})[x.modelo] = x.peso; aprendido = true; }
  return { P, regiao: reg, aprendido };
}
const peso = (P: J, v: string, m: string) => P[v]?.[m] ?? (m === "best_match" ? 1 : 0.5);

// média ponderada robusta: descarta valores muito fora da mediana antes
function combinar(vals: { v: number; w: number }[]) {
  const ok = vals.filter(x => x.v != null && isFinite(x.v) && x.w > 0);
  if (!ok.length) return { media: null as number | null, lo: null as number | null, hi: null as number | null, dp: null as number | null, n: 0 };
  const ord = [...ok].map(x => x.v).sort((a, b) => a - b);
  const med = ord[Math.floor(ord.length / 2)];
  const mad = [...ord].map(v => Math.abs(v - med)).sort((a, b) => a - b)[Math.floor(ord.length / 2)] || 0.5;
  const fil = ok.length >= 4 ? ok.filter(x => Math.abs(x.v - med) <= 3 * mad + 0.5) : ok;
  const W = fil.reduce((s, x) => s + x.w, 0);
  const media = fil.reduce((s, x) => s + x.v * x.w, 0) / W;
  const dp = Math.sqrt(fil.reduce((s, x) => s + x.w * (x.v - media) ** 2, 0) / W);
  const vs = fil.map(x => x.v).sort((a, b) => a - b);
  const q = (p: number) => vs[Math.min(vs.length - 1, Math.max(0, Math.round(p * (vs.length - 1))))];
  return { media, lo: q(0.15), hi: q(0.85), dp, n: fil.length };
}

// ---------------------------------------------------------------- montagem
const NOMES_MODELO: Record<string, string> = {
  ecmwf_ifs025: "ECMWF (Europa)", ecmwf_ifs: "ECMWF (Europa)", ecmwf_aifs025_single: "ECMWF IA", ecmwf_aifs025: "ECMWF IA", icon_seamless: "ICON (Alemanha)", icon_global: "ICON (Alemanha)",
  ukmo_seamless: "UKMO (Reino Unido)", ukmo_global_deterministic_10km: "UKMO (Reino Unido)", meteofrance_seamless: "Météo-France", meteofrance_arpege_world: "Météo-France",
  gfs_seamless: "GFS (EUA)", gfs_global: "GFS (EUA)", gem_seamless: "GEM (Canadá)", gem_global: "GEM (Canadá)", jma_seamless: "JMA (Japão)", jma_gsm: "JMA (Japão)",
  cma_grapes_global: "CMA (China)", kma_seamless: "KMA (Coreia)", bom_access_global: "BOM (Austrália)", metno: "MET Norway", cptec: "CPTEC/INPE", best_match: "Open-Meteo",
};

function icone(prob: number, mm: number, nuvem: number, trov: number) {
  if (trov >= 0.35 && prob >= 45) return "tempestade";
  if (prob >= 60 && mm >= 5) return "chuva";
  if (prob >= 40 && mm >= 1) return "pancadas";
  if (nuvem >= 80) return "nublado";
  if (nuvem >= 40) return "sol-nuvem";
  return "sol";
}
const DESC: Record<string, string> = { tempestade: "Pancadas fortes com trovoadas", chuva: "Chuva", pancadas: "Sol, nuvens e pancadas de chuva", nublado: "Nublado", "sol-nuvem": "Sol entre nuvens", sol: "Ensolarado" };
const REGISTRA = new Set(["temperature_2m_max", "temperature_2m_min", "precipitation_sum"]);
const DSEM = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const dsem = (d: string) => DSEM[new Date(d + "T12:00:00Z").getUTCDay()];

async function previsao(lat: number, lon: number, nome: string, uf: string) {
  await fontes();
  const chave = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const { data: c } = await db.from("cache").select("dados,criado").eq("chave", "p:" + chave).maybeSingle();
  if (c && Date.now() - Date.parse(c.criado) < CACHE_MIN * 60e3) return { ...c.dados, cache: true };

  const om = await openMeteo(lat, lon);
  const [ens, mn, cp, av, pw] = await Promise.all([
    ensemble(lat, lon), metno(lat, lon, om.off), cptec(nome, uf), inmet().catch(() => []), pesos(lat, lon),
  ]);
  const P = pw.P;
  const modelos = Object.keys(om.dm);
  if (!modelos.length && !mn) throw new Error("Nenhuma fonte de previsão respondeu agora.");

  const agoraLocal = new Date(Date.now() + om.off * 1000).toISOString().slice(0, 13);
  const hojeL = agoraLocal.slice(0, 10);
  const diasT = (om.diasT.length ? om.diasT : Object.keys(mn || {}).sort()).filter(d => d >= hojeL).slice(0, 7);

  // ---- horas: média ponderada dos modelos
  const hT = om.horasT;
  const base = om.base?.hourly || {};
  const hIdxBase: Record<string, number> = {}; (base.time || []).forEach((t: string, i: number) => (hIdxBase[t] = i));
  const ensH = ens?.h || {};
  const ensHIdx: Record<string, number> = {}; (ens?.hT || []).forEach((t: string, i: number) => (ensHIdx[t] = i));
  const PESO_ENS: Record<string, number> = { ecmwf_ifs025_ensemble: 0.5, ncep_gefs025: 0.25, icon_seamless_eps: 0.25 };
  const probEnsHora = (t: string) => {
    const i = ensHIdx[t]; if (i == null) return null;
    let s = 0, w = 0;
    for (const [g, membros] of Object.entries(ensH)) {
      const vals = membros.map(m => Math.max(m[i - 1] ?? 0, m[i] ?? 0, m[i + 1] ?? 0)).filter(v => v != null);
      const validos = membros.filter(m => m[i] != null).length;
      if (!validos) continue;
      const pg = PESO_ENS[g] ?? 0.25;
      s += pg * (vals.filter(v => v >= 0.2).length / membros.length); w += pg;
    }
    return w ? (s / w) * 100 : null;
  };
  const horas: J[] = [];
  for (let i = 0; i < hT.length; i++) {
    const t = hT[i];
    const col = (v: string, pv: string) => combinar(modelos.map(m => ({ v: om.hm[m]?.[v]?.[i], w: peso(P, pv, m) })));
    const temp = col("temperature_2m", "tmax"), chuva = col("precipitation", "chuva");
    const nuv = col("cloud_cover", "tmax"), vento = col("wind_speed_10m", "tmax"), raj = col("wind_gusts_10m", "tmax"), ur = col("relative_humidity_2m", "tmax");
    const trov = modelos.length ? modelos.reduce((s, m) => s + ((om.hm[m]?.weather_code?.[i] ?? 0) >= 95 ? peso(P, "chuva", m) : 0), 0) / modelos.reduce((s, m) => s + peso(P, "chuva", m), 0) : 0;
    const bi = hIdxBase[t];
    const pe = probEnsHora(t), pb = bi != null ? base.precipitation_probability?.[bi] : null;
    const detFr = modelos.length ? modelos.reduce((s, m) => s + ((om.hm[m]?.precipitation?.[i] ?? 0) >= 0.2 ? peso(P, "chuva", m) : 0), 0) / modelos.reduce((s, m) => s + peso(P, "chuva", m), 0) * 100 : null;
    const partes = [[pe, 0.6], [pb, 0.2], [detFr, 0.2]].filter(([v]) => v != null) as [number, number][];
    const prob = partes.length ? partes.reduce((s, [v, w]) => s + v * w, 0) / partes.reduce((s, [, w]) => s + w, 0) : 0;
    horas.push({
      t, temp: temp.media, chuva: chuva.media ?? 0, prob, nuvem: nuv.media ?? 0, vento: vento.media, rajada: raj.media, ur: ur.media, trov,
      sens: bi != null ? base.apparent_temperature?.[bi] : null, uv: bi != null ? base.uv_index?.[bi] : null, dia: bi != null ? base.is_day?.[bi] : null,
      dir: bi != null ? base.wind_direction_10m?.[bi] : null, orvalho: bi != null ? base.dew_point_2m?.[bi] : null,
    });
  }

  // ---- dias
  const ensDIdx: Record<string, number> = {}; (ens?.dT || []).forEach((t: string, i: number) => (ensDIdx[t] = i));
  const baseD = om.base?.daily || {};
  const bdIdx: Record<string, number> = {}; (baseD.time || []).forEach((t: string, i: number) => (bdIdx[t] = i));
  const dIdx: Record<string, number> = {}; om.diasT.forEach((t, i) => (dIdx[t] = i));
  const dias: J[] = [];
  for (const [k, d] of diasT.entries()) {
    const i = dIdx[d];
    const mod: J = {};
    const val = (v: string, pv: string, extra: { v: number; w: number }[] = []) => combinar([
      ...modelos.map(m => { const x = i != null ? om.dm[m]?.[v]?.[i] : null; if (x != null && REGISTRA.has(v)) { (mod[m] ||= {})[pv] = r1(x); } return { v: x, w: peso(P, pv, m) }; }),
      ...extra,
    ]);
    const extraMax: { v: number; w: number }[] = [], extraMin: { v: number; w: number }[] = [], extraChuva: { v: number; w: number }[] = [];
    if (mn?.[d]) { extraMax.push({ v: mn[d].tmax, w: peso(P, "tmax", "metno") }); extraMin.push({ v: mn[d].tmin, w: peso(P, "tmin", "metno") }); extraChuva.push({ v: mn[d].chuva, w: peso(P, "chuva", "metno") });
      mod.metno = { tmax: r1(mn[d].tmax), tmin: r1(mn[d].tmin), chuva: r1(mn[d].chuva) }; }
    if (cp?.[d]) { extraMax.push({ v: cp[d].tmax, w: peso(P, "tmax", "cptec") }); extraMin.push({ v: cp[d].tmin, w: peso(P, "tmin", "cptec") });
      mod.cptec = { tmax: cp[d].tmax, tmin: cp[d].tmin, tempo: cp[d].tempo }; }
    const tmax = val("temperature_2m_max", "tmax", extraMax), tmin = val("temperature_2m_min", "tmin", extraMin);
    // chuva: modelos + média dos conjuntos
    let ensMedia: number | null = null, probEns: number | null = null, prob10: number | null = null;
    const ei = ensDIdx[d];
    if (ens && ei != null) {
      let s = 0, w = 0, s10 = 0, sm = 0, wm = 0;
      for (const [g, membros] of Object.entries(ens.d)) {
        const vs = membros.map(m => m[ei]).filter(v => v != null) as number[];
        if (!vs.length) continue;
        const pg = PESO_ENS[g] ?? 0.25;
        s += pg * vs.filter(v => v >= 1).length / vs.length; s10 += pg * vs.filter(v => v >= 10).length / vs.length;
        sm += pg * vs.reduce((a, b) => a + b, 0) / vs.length; w += pg; wm += pg;
      }
      if (w) { probEns = (s / w) * 100; prob10 = (s10 / w) * 100; ensMedia = sm / wm; }
    }
    if (ensMedia != null) extraChuva.push({ v: ensMedia, w: 1.2 });
    const chuva = val("precipitation_sum", "chuva", extraChuva);
    const wsum = modelos.reduce((s, m) => s + (i != null && om.dm[m]?.precipitation_sum?.[i] != null ? peso(P, "chuva", m) : 0), 0);
    const detFr = wsum ? modelos.reduce((s, m) => s + ((i != null ? om.dm[m]?.precipitation_sum?.[i] ?? 0 : 0) >= 1 ? peso(P, "chuva", m) : 0), 0) / wsum * 100 : null;
    const pb = bdIdx[d] != null ? baseD.precipitation_probability_max?.[bdIdx[d]] : null;
    const partes = [[probEns, 0.65], [detFr, 0.25], [pb != null ? pb * 0.85 : null, 0.1]].filter(([v]) => v != null) as [number, number][];
    const prob = partes.length ? partes.reduce((s, [v, w]) => s + v * w, 0) / partes.reduce((s, [, w]) => s + w, 0) : 0;
    const trovW = modelos.reduce((s, m) => s + (i != null && om.dm[m]?.weather_code?.[i] != null ? peso(P, "chuva", m) : 0), 0);
    const trov = trovW ? modelos.reduce((s, m) => s + ((i != null ? om.dm[m]?.weather_code?.[i] ?? 0 : 0) >= 95 ? peso(P, "chuva", m) : 0), 0) / trovW : 0;
    const raj = val("wind_gusts_10m_max", "tmax"), vento = val("wind_speed_10m_max", "tmax");
    // horas do dia: ajusta curva horária para bater com máxima/mínima combinadas
    const hs = horas.filter(h => h.t.startsWith(d));
    const temps = hs.map(h => h.temp).filter((v: any) => v != null);
    if (temps.length >= 20 && tmax.media != null && tmin.media != null) {
      const hmx = Math.max(...temps), hmn = Math.min(...temps);
      if (hmx - hmn > 0.5) for (const h of hs) if (h.temp != null) h.temp = tmin.media + ((h.temp - hmn) / (hmx - hmn)) * (tmax.media - tmin.media);
    }
    const diaH = hs.filter(h => +h.t.slice(11, 13) >= 7 && +h.t.slice(11, 13) <= 17);
    const nuvem = diaH.length ? diaH.reduce((s, h) => s + h.nuvem, 0) / diaH.length : 50;
    const urMin = hs.length ? Math.min(...hs.map(h => h.ur ?? 100)) : null;
    // períodos com chuva
    const per = (a: number, b: number) => Math.max(0, ...hs.filter(h => +h.t.slice(11, 13) >= a && +h.t.slice(11, 13) < b).map(h => h.prob));
    const periodos = { madrugada: r0(per(0, 6)), manha: r0(per(6, 12)), tarde: r0(per(12, 18)), noite: r0(per(18, 24)) };
    // confiança: concordância entre modelos + distância do 50% + antecedência
    let pts = 3;
    if ((tmax.dp ?? 0) > 1.5) pts--; if ((tmax.dp ?? 0) > 3) pts--;
    if (prob > 30 && prob < 70) pts--;
    if (k >= 4) pts--; if (k >= 6) pts--;
    if (tmax.n < 3) pts--;
    const conf = pts >= 3 ? "alta" : pts >= 1 ? "média" : "baixa";
    const ic = icone(prob, chuva.media ?? 0, nuvem, trov);
    const bi = bdIdx[d];
    dias.push({
      data: d, semana: dsem(d), icone: ic, desc: DESC[ic],
      tmax: r1(tmax.media), tmin: r1(tmin.media), tmaxFaixa: [r0(tmax.lo), r0(tmax.hi)], tminFaixa: [r0(tmin.lo), r0(tmin.hi)],
      chuva: r1(chuva.media), chuvaFaixa: [r1(chuva.lo), r1(chuva.hi)], prob: r0(prob), prob10: r0(prob10), trov: r1(trov),
      vento: r0(vento.media), rajada: r0(raj.media), uv: bi != null ? r1(baseD.uv_index_max?.[bi]) : null,
      nascer: bi != null ? baseD.sunrise?.[bi]?.slice(11, 16) : null, por: bi != null ? baseD.sunset?.[bi]?.slice(11, 16) : null,
      urMin: r0(urMin), nuvem: r0(nuvem), periodos, confianca: conf, nModelos: tmax.n, modelos: mod, cptec: cp?.[d]?.tempo || null,
    });
  }

  // ---- agora
  const cur = om.base?.current;
  const hAgora = horas.findIndex(h => h.t.slice(0, 13) === agoraLocal);
  const proxH = horas.slice(Math.max(0, hAgora), Math.max(0, hAgora) + 48);
  const agora = cur ? {
    temp: r1(cur.temperature_2m), sens: r1(cur.apparent_temperature), ur: r0(cur.relative_humidity_2m), vento: r0(cur.wind_speed_10m),
    rajada: r0(cur.wind_gusts_10m), dir: r0(cur.wind_direction_10m), chuva: r1(cur.precipitation), nuvem: r0(cur.cloud_cover), dia: cur.is_day,
    icone: (cur.precipitation ?? 0) >= 0.2 ? ((cur.weather_code ?? 0) >= 95 ? "tempestade" : "chuva") : icone(0, 0, cur.cloud_cover ?? 50, 0),
    hora: cur.time,
  } : (proxH[0] ? { temp: r1(proxH[0].temp), ur: r0(proxH[0].ur), vento: r0(proxH[0].vento), rajada: r0(proxH[0].rajada), chuva: r1(proxH[0].chuva), nuvem: r0(proxH[0].nuvem), icone: icone(proxH[0].prob, proxH[0].chuva, proxH[0].nuvem, proxH[0].trov), hora: proxH[0].t } : null);
  if (agora && agora.icone === "sol" && agora.dia === 0) agora.icone = "noite";

  // ---- alertas
  const alertas: J[] = [];
  for (const a of av as J[]) {
    if (!noPoligono(lat, lon, a.poligono)) continue;
    const sev = norm(a.severidade || "");
    alertas.push({ fonte: "INMET", oficial: true, nivel: sev.includes("grande") ? "grave" : sev === "perigo" ? "perigo" : "atencao",
      titulo: a.descricao, texto: (a.riscos || []).join(" "), instrucoes: a.instrucoes, inicio: a.inicio, fim: a.fim, cor: a.cor, chave: `inmet:${a.id}` });
  }
  for (const [k, d] of dias.slice(0, 3).entries()) {
    const quando = k === 0 ? "Hoje" : k === 1 ? "Amanhã" : `Na ${d.semana}`;
    const add = (tipo: string, nivel: string, titulo: string, texto: string) => alertas.push({ fonte: "Radar", nivel, titulo, texto, data: d.data, chave: `${tipo}:${d.data}` });
    if ((d.trov ?? 0) >= 0.4 && d.prob >= 50) add("tempestade", (d.chuva ?? 0) >= 30 ? "perigo" : "atencao", `${quando}: risco de temporal`, `Trovoadas previstas, ${d.prob}% de chance de chuva e até ${r0(d.chuvaFaixa[1] ?? d.chuva)} mm. Rajadas de até ${d.rajada} km/h.`);
    else if ((d.chuva ?? 0) >= 30 && d.prob >= 60) add("chuva", (d.chuva ?? 0) >= 50 ? "perigo" : "atencao", `${quando}: chuva forte`, `Acumulado previsto de ${r0(d.chuva)} mm (pode chegar a ${r0(d.chuvaFaixa[1])} mm).`);
    if ((d.rajada ?? 0) >= 60) add("vento", (d.rajada ?? 0) >= 80 ? "perigo" : "atencao", `${quando}: ventania`, `Rajadas de até ${d.rajada} km/h.`);
    if ((d.tmax ?? 0) >= 35) add("calor", (d.tmax ?? 0) >= 38 ? "perigo" : "atencao", `${quando}: calor forte`, `Máxima de ${r0(d.tmax)}°C. Beba água e evite sol entre 11h e 16h.`);
    if ((d.tmin ?? 99) <= 3) add("geada", (d.tmin ?? 99) <= 1 ? "perigo" : "atencao", `${quando}: risco de geada`, `Mínima de ${r0(d.tmin)}°C de madrugada. Proteja mudas e lavouras em baixadas.`);
    else if ((d.tmin ?? 99) <= 7) add("frio", "atencao", `${quando}: frio intenso`, `Mínima de ${r0(d.tmin)}°C.`);
    if ((d.urMin ?? 100) <= 30) add("seco", (d.urMin ?? 100) <= 12 ? "grave" : (d.urMin ?? 100) <= 20 ? "perigo" : "atencao", `${quando}: ar muito seco`, `Umidade pode baixar para ${d.urMin}% à tarde. Hidrate-se e evite queimadas.`);
    if (k === 0 && (d.uv ?? 0) >= 11) add("uv", "info", "Índice UV extremo hoje", `UV até ${r0(d.uv)}. Use protetor e chapéu.`);
  }
  // chuva chegando nas próximas horas
  const agoraChove = (agora?.chuva ?? 0) >= 0.2;
  const prox6 = proxH.slice(1, 7);
  const ini = prox6.find(h => h.prob >= 60 && h.chuva >= 0.3);
  if (!agoraChove && ini) alertas.push({ fonte: "Radar", nivel: "info", titulo: `Chuva deve chegar por volta das ${+ini.t.slice(11, 13)}h`, texto: `${r0(ini.prob)}% de chance nessa hora.`, chave: `chegando:${ini.t.slice(0, 13)}` });
  const ordem: J = { grave: 0, perigo: 1, atencao: 2, info: 3 };
  alertas.sort((a, b) => ordem[a.nivel] - ordem[b.nivel]);

  // ---- campo: pulverização, secagem e geada
  const janelas: J[] = [];
  let atual: J | null = null;
  for (let i = 0; i < Math.min(proxH.length, 48); i++) {
    const h = proxH[i], hr = +h.t.slice(11, 13);
    const futuro = proxH.slice(i, i + 3);
    const bom = hr >= 6 && hr <= 18 && h.vento != null && h.vento >= 2 && h.vento <= 12 && (h.temp ?? 40) <= 30 && (h.ur ?? 0) >= 50 && futuro.every(f => f.prob < 35 && f.chuva < 0.2);
    if (bom) { if (atual && atual.fim === proxH[i - 1]?.t) { atual.fim = h.t; atual.horas++; } else { atual = { inicio: h.t, fim: h.t, horas: 1 }; janelas.push(atual); } }
  }
  const campo = {
    pulverizacao: janelas.filter(j => j.horas >= 2).slice(0, 6).map(j => ({ inicio: j.inicio, fim: j.fim, horas: j.horas })),
    secagem: dias.map(d => ({ data: d.data, nota: d.prob < 25 && d.nuvem < 70 && (d.urMin ?? 100) < 60 ? "boa" : d.prob < 45 && (d.urMin ?? 100) < 75 ? "regular" : "ruim" })),
    chuvaSemana: r0(dias.reduce((s, d) => s + (d.chuva ?? 0) * Math.min(1, (d.prob ?? 0) / 60), 0)),
    geada: dias.filter(d => (d.tmin ?? 99) <= 4).map(d => ({ data: d.data, tmin: d.tmin })),
  };

  // ---- resumo em texto
  const frase = (d: J, rot: string) => {
    let s = `${rot}: ${d.desc.toLowerCase()}, de ${r0(d.tmin)}° a ${r0(d.tmax)}°.`;
    if (d.prob >= 60) s += ` Chuva provável (${d.prob}%), cerca de ${r0(d.chuva)} mm.`;
    else if (d.prob >= 30) { const p = Object.entries(d.periodos).sort((a: any, b: any) => b[1] - a[1])[0]; s += ` Pode chover, principalmente ${p[0] === "manha" ? "de manhã" : p[0] === "tarde" ? "à tarde" : p[0] === "noite" ? "à noite" : "de madrugada"} (${d.prob}%).`; }
    else s += " Chuva pouco provável.";
    return s;
  };
  const resumo: string[] = [];
  if (dias[0]) resumo.push(frase(dias[0], "Hoje"));
  if (dias[1]) resumo.push(frase(dias[1], "Amanhã"));
  const resto = dias.slice(2);
  if (resto.length) {
    const chuvosos = resto.filter(d => d.prob >= 55).map(d => d.semana);
    const quente = [...resto].sort((a, b) => (b.tmax ?? 0) - (a.tmax ?? 0))[0];
    resumo.push(chuvosos.length ? `Resto da semana: chuva mais provável na ${chuvosos.slice(0, 3).join(", ")}.` : "Resto da semana: sem chuva significativa à vista.");
    if (quente && (quente.tmax ?? 0) >= (dias[0]?.tmax ?? 0) + 2) resumo.push(`Dia mais quente: ${quente.semana}, perto de ${r0(quente.tmax)}°.`);
  }

  const usados = [...modelos.map(m => NOMES_MODELO[m] || m), ...(mn ? ["MET Norway"] : []), ...(cp ? ["CPTEC/INPE"] : [])];
  const out = {
    versao: VERSAO, gerado: new Date().toISOString(), local: { nome, uf, lat, lon, elev: om.elev, tz: om.tz },
    agora, resumo, alertas, dias, campo,
    horas: proxH.map(h => ({ t: h.t, temp: r1(h.temp), sens: r1(h.sens), chuva: r1(h.chuva), prob: r0(h.prob), nuvem: r0(h.nuvem), vento: r0(h.vento), rajada: r0(h.rajada), ur: r0(h.ur), uv: r1(h.uv), dia: h.dia, icone: (() => { const ic = icone(h.prob, h.chuva * 6, h.nuvem, h.trov); return ic === "sol" && h.dia === 0 ? "noite" : ic === "sol-nuvem" && h.dia === 0 ? "noite-nuvem" : ic; })() })),
    // todas as horas da semana (só o essencial) para o detalhe de cada dia
    semanaHoras: horas.filter(h => h.t >= hojeL).map(h => [h.t.slice(5, 13), r0(h.temp), r0(h.prob), r1(h.chuva)]),
    fontes: { usadas: usados, ensemble: ens ? Object.keys(ens.d).map(g => `${g.replace(/_ensemble|025|_seamless/g, "").replace(/_/g, " ").toUpperCase()} (${ens.d[g].length} cenários)`) : [], pesosAprendidos: pw.aprendido, regiao: pw.regiao, saude: saudeRodada.map(s => ({ id: s.id, ok: s.ok })) },
  };
  await db.from("cache").upsert({ chave: "p:" + chave, dados: out, criado: new Date().toISOString() });
  db.rpc("contar_local", { p_chave: chave, p_nome: nome, p_uf: uf, p_lat: lat, p_lon: lon }).then(() => {}, () => {});
  return out;
}

// ---------------------------------------------------------------- robôs
async function cronOk(req: Request) {
  const t = req.headers.get("x-cron");
  if (!t) return false;
  const { data } = await db.from("estado").select("valor").eq("chave", "cron_token").maybeSingle();
  return !!data?.valor && data.valor === t;
}

// Guarda a previsão de cada modelo para os locais mais usados e confere com o que aconteceu.
async function verificar() {
  await fontes();
  const { data: locais } = await db.from("locais").select("chave,nome,uf,lat,lon").order("consultas", { ascending: false }).limit(40);
  const log: string[] = [];
  const ontem = new Date(Date.now() - 3 * 3600e3 - 86400e3).toISOString().slice(0, 10);
  const t0 = Date.now();
  for (const l of locais ?? []) {
    if (Date.now() - t0 > 110e3) { log.push("tempo esgotado: o restante fica para amanhã"); break; }
    try {
      const om = await openMeteo(l.lat, l.lon);
      const mn = await metno(l.lat, l.lon, om.off);
      const hoje = om.diasT[0];
      const linhas: J[] = [];
      om.diasT.forEach((d, i) => {
        if (i < 1 || i > 7) return;
        for (const m of Object.keys(om.dm)) {
          const x = om.dm[m];
          if (x.temperature_2m_max?.[i] == null) continue;
          linhas.push({ local: l.chave, data_alvo: d, antecedencia: i, modelo: m, tmax: x.temperature_2m_max[i], tmin: x.temperature_2m_min?.[i], chuva: x.precipitation_sum?.[i] });
        }
        if (mn?.[d]) linhas.push({ local: l.chave, data_alvo: d, antecedencia: i, modelo: "metno", tmax: mn[d].tmax, tmin: mn[d].tmin, chuva: mn[d].chuva });
      });
      if (linhas.length) await db.from("previsoes_modelo").upsert(linhas);
      // primeira vez neste local: usa as previsões antigas de cada modelo (arquivo do Open-Meteo)
      // dos últimos 60 dias para já começar com pesos ajustados à região
      const { data: boot } = await db.from("estado").select("valor").eq("chave", "boot:" + l.chave).maybeSingle();
      if (!boot) {
        const mods = Object.keys(om.dm).filter(m => m !== "best_match");
        const fim = ontem, ini60 = new Date(Date.parse(ontem) - 60 * 86400e3).toISOString().slice(0, 10);
        const hist = await pegarValido("om_arquivo", () => pegar("om_arquivo", `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${l.lat}&longitude=${l.lon}&start_date=${ini60}&end_date=${fim}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&models=${mods.join(",")}&timezone=auto`, "json", 20000),
          (j: J) => Array.isArray(j?.daily?.time));
        if (hist) {
          const dmH = porModelo(hist.daily, ["temperature_2m_max", "temperature_2m_min", "precipitation_sum"], mods);
          const hl: J[] = [];
          hist.daily.time.forEach((d: string, i: number) => { for (const m of Object.keys(dmH)) { const x = dmH[m]; if (x.temperature_2m_max?.[i] == null) continue;
            hl.push({ local: l.chave, data_alvo: d, antecedencia: 1, modelo: m, tmax: x.temperature_2m_max[i], tmin: x.temperature_2m_min?.[i], chuva: x.precipitation_sum?.[i] }); } });
          for (let i = 0; i < hl.length; i += 500) await db.from("previsoes_modelo").upsert(hl.slice(i, i + 500), { ignoreDuplicates: true });
          const obA = await pegarValido("om_arquivo", () => pegar("om_arquivo", `${cfg("om_arquivo").url || "https://archive-api.open-meteo.com/v1/archive"}?latitude=${l.lat}&longitude=${l.lon}&start_date=${ini60}&end_date=${fim}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`, "json", 20000),
            (j: J) => Array.isArray(j?.daily?.time));
          if (obA) await db.from("observado").upsert(obA.daily.time.map((d: string, i: number) => ({ local: l.chave, data: d, tmax: obA.daily.temperature_2m_max[i], tmin: obA.daily.temperature_2m_min[i], chuva: obA.daily.precipitation_sum[i], fonte: "era5" })).filter((o: J) => o.tmax != null));
          await db.from("estado").upsert({ chave: "boot:" + l.chave, valor: String(hl.length) });
          log.push(`${l.nome}: histórico de ${hl.length} previsões antigas para calibrar`);
        }
      }
      // observado (reanálise ERA5 do Open-Meteo, disponível com 1 a 5 dias de atraso)
      const ini = new Date(Date.parse(ontem) - 6 * 86400e3).toISOString().slice(0, 10);
      const arq = cfg("om_arquivo").url || "https://archive-api.open-meteo.com/v1/archive";
      const ob = await pegarValido("om_arquivo", () => pegar("om_arquivo", `${arq}?latitude=${l.lat}&longitude=${l.lon}&start_date=${ini}&end_date=${ontem}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`),
        (j: J) => Array.isArray(j?.daily?.time));
      if (ob) {
        const obs = ob.daily.time.map((d: string, i: number) => ({ local: l.chave, data: d, tmax: ob.daily.temperature_2m_max[i], tmin: ob.daily.temperature_2m_min[i], chuva: ob.daily.precipitation_sum[i], fonte: "era5" }))
          .filter((o: J) => o.tmax != null);
        if (obs.length) await db.from("observado").upsert(obs);
      }
      log.push(`${l.nome}: ${linhas.length} previsões guardadas` + (hoje ? "" : ""));
    } catch (e: any) { log.push(`${l.nome}: erro ${e?.message ?? e}`); }
  }
  const { data: rp } = await db.rpc("recalcular_pesos");
  await db.from("cache").delete().lt("criado", new Date(Date.now() - 2 * 86400e3).toISOString());
  await db.from("previsoes_modelo").delete().lt("data_alvo", new Date(Date.now() - 120 * 86400e3).toISOString().slice(0, 10));
  return { locais: locais?.length ?? 0, pesos: rp, log };
}

// Confere se os modelos configurados ainda respondem e troca por equivalentes quando um some.
const GRUPOS: string[][] = [
  ["ecmwf_ifs025", "ecmwf_ifs", "ecmwf_ifs04"], ["ecmwf_aifs025_single", "ecmwf_aifs025"], ["icon_seamless", "icon_global"],
  ["ukmo_seamless", "ukmo_global_deterministic_10km"], ["meteofrance_seamless", "meteofrance_arpege_world"], ["gfs_seamless", "gfs_global", "gfs025"],
  ["gem_seamless", "gem_global"], ["jma_seamless", "jma_gsm"], ["cma_grapes_global"], ["kma_seamless", "kma_gdps"],
];
async function modelos() {
  await fontes();
  const sync = await sincronizarConfig().catch((e) => ({ ok: false, erro: String(e) }));
  const c = cfg("openmeteo");
  const url = c.url || "https://api.open-meteo.com/v1/forecast";
  const todos = [...new Set(GRUPOS.flat())];
  const resposta: Record<string, boolean> = {};
  for (let i = 0; i < todos.length; i += 6) {
    const lote = todos.slice(i, i + 6);
    try {
      const r = await fetch(`${url}?latitude=-19.9&longitude=-43.9&daily=temperature_2m_max&forecast_days=7&models=${lote.join(",")}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
      const j = await r.json();
      for (const m of lote) { const a = j?.daily?.[`temperature_2m_max_${m}`]; resposta[m] = Array.isArray(a) && a.filter((x: any) => x != null).length >= 3; }
    } catch (_) { for (const m of lote) resposta[m] ??= false; }
  }
  if (!Object.values(resposta).some(Boolean)) return { erro: "Open-Meteo não respondeu; nada alterado", resposta };
  const escolhidos = GRUPOS.map(g => g.find(m => resposta[m])).filter(Boolean) as string[];
  const antes: string[] = c.modelos || [];
  const mudou = escolhidos.join(",") !== antes.join(",");
  if (mudou && escolhidos.length >= 3) {
    await db.from("fontes").update({ config: { ...c, modelos: escolhidos }, atualizado: new Date().toISOString() }).eq("id", "openmeteo");
    // modelo novo herda o peso do antigo do mesmo grupo
    for (const g of GRUPOS) {
      const novo = g.find(m => resposta[m]); const velho = g.find(m => antes.includes(m));
      if (novo && velho && novo !== velho) {
        const { data: ps } = await db.from("pesos").select("*").eq("modelo", velho);
        if (ps?.length) await db.from("pesos").upsert(ps.map((p: J) => ({ ...p, modelo: novo, amostras: 0 })));
      }
    }
    await db.from("manutencao").insert({ quem: "robô de modelos", resumo: `Modelos atualizados automaticamente: ${antes.join(", ")} → ${escolhidos.join(", ")}` });
  }
  return { mudou, antes, escolhidos, resposta, sync };
}

// Notificações no celular
async function avisos(teste?: string) {
  const webpush = (await import("npm:web-push@3.6.7")).default;
  const { data: est } = await db.from("estado").select("chave,valor").in("chave", ["vapid_public", "vapid_private"]);
  const E = Object.fromEntries((est ?? []).map((x: J) => [x.chave, x.valor]));
  webpush.setVapidDetails("mailto:radar-clima@users.noreply.github.com", E.vapid_public, E.vapid_private);
  const enviar = async (s: J, payload: J) => {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3 * 3600, urgency: payload.urgente ? "high" : "normal" }); return true; }
    catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await db.from("inscricoes").delete().eq("endpoint", s.endpoint); return false; }
  };
  if (teste) {
    const { data: s } = await db.from("inscricoes").select("*").eq("endpoint", teste).maybeSingle();
    if (!s) return { ok: false, erro: "inscrição não encontrada" };
    return { ok: await enviar(s, { title: "Radar do Clima", body: `Teste: os avisos para ${s.nome || "seu local"} estão funcionando. ☀️`, tag: "teste", url: SITE }) };
  }
  const { data: subs } = await db.from("inscricoes").select("*");
  const horaBR = +new Date(Date.now() - 3 * 3600e3).toISOString().slice(11, 13);
  const hojeBR = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const porLocal: Record<string, J[]> = {};
  for (const s of subs ?? []) (porLocal[`${s.lat.toFixed(2)},${s.lon.toFixed(2)}|${s.nome}`] ||= []).push(s);
  let enviados = 0;
  for (const [k, lista] of Object.entries(porLocal)) {
    const s0 = lista[0];
    let p: J;
    try { p = await previsao(s0.lat, s0.lon, s0.nome || "", s0.prefs?.uf || ""); } catch (_) { continue; }
    const url = `${SITE}?lat=${s0.lat}&lon=${s0.lon}&n=${encodeURIComponent(s0.nome || "")}`;
    for (const s of lista) {
      const pr = s.prefs || {};
      const fila: J[] = [];
      for (const a of p.alertas) {
        const tipo = a.chave.split(":")[0];
        const quer = a.fonte === "INMET" ? pr.inmet !== false
          : tipo === "chegando" ? pr.chegando !== false
          : ["tempestade", "chuva"].includes(tipo) ? pr.chuva !== false
          : ["geada", "frio"].includes(tipo) ? pr.frio !== false
          : tipo === "calor" || tipo === "seco" ? pr.calor !== false
          : tipo === "vento" ? pr.vento !== false : false;
        if (quer && a.nivel !== "info" || (quer && tipo === "chegando")) fila.push({ chave: a.chave, title: `${a.nivel === "grave" || a.nivel === "perigo" ? "⚠️ " : ""}${a.titulo}`, body: `${s.nome}: ${a.texto}`.slice(0, 220), urgente: a.nivel !== "info" });
      }
      if (pr.resumo !== false && horaBR === (pr.horaResumo ?? 6) && p.resumo?.length) fila.push({ chave: `resumo:${hojeBR}`, title: `${s.nome}: ${r0(p.dias[0]?.tmin)}° a ${r0(p.dias[0]?.tmax)}°, chuva ${p.dias[0]?.prob}%`, body: p.resumo.slice(0, 2).join(" ") });
      if (!fila.length) continue;
      const { data: ja } = await db.from("enviados").select("chave").eq("endpoint", s.endpoint).in("chave", fila.map(f => f.chave));
      const jaSet = new Set((ja ?? []).map((x: J) => x.chave));
      for (const f of fila.filter(f => !jaSet.has(f.chave)).slice(0, 3)) {
        if (await enviar(s, { title: f.title, body: f.body, tag: f.chave, url, urgente: f.urgente })) {
          enviados++; await db.from("enviados").upsert({ endpoint: s.endpoint, chave: f.chave });
        }
      }
    }
  }
  await db.from("enviados").delete().lt("quando", new Date(Date.now() - 10 * 86400e3).toISOString());
  return { inscricoes: subs?.length ?? 0, enviados };
}

// ---------------------------------------------------------------- rotas
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const u = new URL(req.url);
  const corpo = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const p = (k: string) => u.searchParams.get(k) ?? corpo[k] ?? "";
  const acao = p("acao") || "previsao";
  try {
    await fontes();
    if (acao === "buscar") {
      const q = String(p("q")).trim().slice(0, 80);
      if (q.length < 2) return resp({ locais: [] });
      const digitos = q.replace(/\D/g, "");
      const locais = digitos.length === 8 && /^[\d\s.\-]+$/.test(q) ? await porCep(digitos) : await porCidade(q);
      return resp({ locais }, 200, { "Cache-Control": "public, max-age=3600" });
    }
    if (acao === "reverso") return resp(await reverso(+p("lat"), +p("lon")));
    if (acao === "previsao") {
      const lat = +p("lat"), lon = +p("lon");
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return resp({ erro: "coordenadas inválidas" }, 400);
      return resp(await previsao(Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4, String(p("nome")).slice(0, 80), String(p("uf")).slice(0, 2).toUpperCase()), 200, { "Cache-Control": "public, max-age=300" });
    }
    if (acao === "saude") {
      const [{ data: f }, { data: pe }, { data: m }, { data: mv }] = await Promise.all([
        db.from("fontes").select("id,nome,tipo,ativo,ok_total,falha_total,falhas_seguidas,ultimo_ok,ultima_falha,ultimo_erro,ms_medio,config"),
        db.from("pesos").select("regiao,modelo,variavel,peso,erro_medio,amostras").order("peso", { ascending: false }),
        db.from("manutencao").select("quando,quem,resumo").order("quando", { ascending: false }).limit(15),
        db.from("estado").select("valor").eq("chave", "modelos_vazios").maybeSingle(),
      ]);
      return resp({ versao: VERSAO, fontes: f, pesos: pe, manutencao: m, modelosVazios: mv?.valor ? JSON.parse(mv.valor) : null });
    }
    if (acao === "teste_aviso") return resp(await avisos(String(p("endpoint"))));
    if (["verificar", "avisos", "modelos"].includes(acao)) {
      if (!(await cronOk(req))) return resp({ erro: "não autorizado" }, 401);
      if (acao === "verificar") return resp(await verificar());
      if (acao === "modelos") return resp(await modelos());
      return resp(await avisos());
    }
    return resp({ erro: "ação desconhecida" }, 400);
  } catch (e: any) {
    return resp({ erro: String(e?.message ?? e) }, 502);
  }
});
