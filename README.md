# 2026 Választási Prediktor

Interaktív webes alkalmazás a 2026-os magyar országgyűlési választás eredményének modellezésére. A felhasználó kerületenként beállíthatja a jelöltek százalékos eredményét, az országos listás szavazatokat és a részvételi arányt — az alkalmazás valós időben kiszámolja a 199 fős parlament összetételét a választási törvény szabályai szerint.

## Funkciók

### Kézi predikció
- **Egyéni választókerületek (OEVK)**: a térképen vagy a táblázatban kattintva megnyílik a kerület részletpanelje, ahol minden jelöltnek beállítható a várható százalékos eredmény. Ha csak a nagypártok értékeit töltöd ki, a program automatikusan elosztja a maradékot a többi jelölt között.
- **Országos listás szavazatok**: belföldi és levélszavazatok külön-külön állíthatók pártokként. A mezőbe írt érték Enter leütésekor lép érvénybe.
- **Részvételi arány**: csúszkával állítható (30–90%). A csúszka felengedésekor az országos listás szavazatszámok arányosan skálázódnak. Fordítva is működik: ha a listás szavazatszámokat módosítod, a részvételi arány automatikusan frissül.

### Választási matematika
Az alkalmazás a választási törvény (2011. évi CCIII. törvény) alapján számol:
- **106 egyéni mandátum**: az adott OEVK-ban a legtöbb szavazatot kapó jelölt nyer.
- **Töredékszavazatok**: a vesztes jelöltek összes szavazata + a győztes jelölt szavazatainak a második helyezettnél eggyel többel meghaladó része.
- **93 listás mandátum**: a listás szavazatok + töredékszavazatok összegéből, D'Hondt módszerrel, a küszöb feletti pártok között elosztva.
- **Küszöbök**: 5% egypárti listáknál, 10% kétpárti koalíciónál (pl. FIDESZ-KDNP), 15% három vagy több párti koalíciónál.

### Vizualizációk
- **Interaktív térkép**: Magyarország 106 egyéni választókerülete SVG poligonokkal, a becsült győztes pártszínével kitöltve. Hover: kerületnév + győztes. Kattintás: részletpanel.
- **Parlamenti patkó diagram**: 199 mandátum félkör alakban, pártszínek szerint csoportosítva bal-jobb spektrum mentén. Középen a vezető párt mandátumszáma és többségi státusza.
- **Táblázatok**: OEVK lista (kerületenkénti győztes és előny), országos összesítő (OEVK + listás + össz mandátumok pártokként), töredékszavazat-kimutatás.

### Automatikus kitöltés
Az **Auto kitöltés polling alapján** gomb a Wikipedia közvélemény-kutatási adataiból tölti fel a predikciót:
- Az utolsó 5 poll átlagát veszi a legfrissebb adatokból.
- Uniform national swing módszerrel a 2022-es OEVK eredményekből kiindulva becsüli a kerületi szintű eredményeket.
- Az előtöltött értékek utána kézzel módosíthatók.

Az **Adatok törlése** gomb minden értéket nullára állít.

### Adatforrás
Az alkalmazás a Nemzeti Választási Iroda hivatalos adatszolgáltatását használja:
- Jelöltek, pártlisták, választókerületek, választópolgár-számok: [vtr.valasztas.hu](https://vtr.valasztas.hu/ogy2026/)
- 2022-es OEVK eredmények (swing kalkulátorhoz)
- Választókerületi és megyehatár poligonok (térkép)

Csak a nyilvántartásba vett (`állapot: "1"`) listák és jelöltek jelennek meg.

---

## Telepítés

### Előfeltételek

- **Git** ([letöltés](https://git-scm.com/downloads))
- **Egy webszerver** az alábbiak egyike:
  - **Python 3** (beépített `http.server` modul) — [letöltés](https://www.python.org/downloads/)
  - **Node.js** (`npx serve` vagy `http-server`) — [letöltés](https://nodejs.org/)
  - Vagy bármilyen statikus fájlszerver (Apache, nginx, Caddy, stb.)

> Az alkalmazás tisztán HTML + JavaScript, nincs build lépés, nincs dependency — csak egy HTTP szerverre van szüksége, amely a fájlokat a megfelelő MIME-típussal szolgálja ki.

### 1. Repó klónozása

```bash
git clone https://github.com/saaa2020/valasztasi-prediktor.git
cd valasztasi-prediktor
```

### 2. Választási adatok letöltése

Az alkalmazás a Nemzeti Választási Iroda API-jából tölti az adatokat. Mivel az API nem támogat CORS-t, a fejlesztéshez lokálisan kell cache-elni az adatfájlokat:

```bash
mkdir -p data/cache
cd data/cache

curl -s "https://vtr.valasztas.hu/ogy2026/data/config.json" -o config.json

# Verzió kiolvasása
# Linux/macOS:
VER=$(cat config.json | grep -o '"ver":"[^"]*"' | cut -d'"' -f4)
# Windows (PowerShell):
# $VER = (Get-Content config.json | ConvertFrom-Json).ver

BASE="https://vtr.valasztas.hu/ogy2026/data/$VER/ver"

for f in Szervezetek EgyeniJeloltek ListakEsJeloltek Jlcs OevkAdatok OevkPoligonok Megyek ElozoOevkEredmenyek OsszLetszam; do
    echo "Letöltés: $f.json..."
    curl -s "$BASE/$f.json" -o "$f.json"
done

cd ../..
```

Ez ~3.5 MB adatot tölt le. A `data/cache/` mappa a `.gitignore`-ban szerepel, nem kerül be a repóba.

### 3. Szerver indítása

#### Python 3-mal (legegyszerűbb)

```bash
python3 -m http.server 8080
```

#### Node.js-szel

```bash
# npx-szel (nincs telepítés):
npx serve -l 8080

# vagy globálisan telepített http-server:
npm install -g http-server
http-server -p 8080
```

#### PowerShell-lel (ha se Python, se Node nincs)

```powershell
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add('http://localhost:8080/')
$listener.Start()
Write-Host 'Szerver elindult: http://localhost:8080'
while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $path = $ctx.Request.Url.LocalPath
    if ($path -eq '/') { $path = '/index.html' }
    $file = Join-Path $PWD ($path.TrimStart('/').Replace('/', '\'))
    if (Test-Path $file -PathType Leaf) {
        $bytes = [IO.File]::ReadAllBytes($file)
        $ext = [IO.Path]::GetExtension($file)
        $ctx.Response.ContentType = @{
            '.html'='text/html; charset=utf-8'
            '.css'='text/css; charset=utf-8'
            '.js'='application/javascript; charset=utf-8'
            '.json'='application/json; charset=utf-8'
        }[$ext] ?? 'application/octet-stream'
        $ctx.Response.ContentLength64 = $bytes.Length
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
        $ctx.Response.StatusCode = 404
    }
    $ctx.Response.Close()
}
```

### 4. Megnyitás böngészőben

Nyisd meg a böngészőben: **http://localhost:8080**

Az alkalmazás automatikusan betölti az adatokat a `data/cache/` mappából, és megjeleníti a térképet a becsült eredményekkel.

### Éles üzemeltetés (opcionális)

Éles környezetben a `data/cache/` helyett közvetlenül az API-ból is tölthet az alkalmazás, de ehhez CORS proxy szükséges, mert a `vtr.valasztas.hu` nem küld `Access-Control-Allow-Origin` headert.

**Cloudflare Worker proxy** (~20 sor kód, ingyenes szinten 100 000 kérés/nap):

```javascript
export default {
    async fetch(request) {
        const url = new URL(request.url);
        const target = decodeURIComponent(url.pathname.slice(1));
        if (!target.startsWith('https://vtr.valasztas.hu/')) {
            return new Response('Forbidden', { status: 403 });
        }
        const resp = await fetch(target);
        const headers = new Headers(resp.headers);
        headers.set('Access-Control-Allow-Origin', '*');
        return new Response(resp.body, { status: resp.status, headers });
    }
};
```

A `js/data.js` fájlban a `CORS_PROXY` konstanst állítsd a saját worker URL-edre.

Statikus hosting lehetőségek: GitHub Pages, Netlify, Cloudflare Pages — mind ingyenesek és build lépés nélkül működnek (a `data/cache/` fájlokat is tedd fel mellé, vagy használj CORS proxy-t).

---

## Projektstruktúra

```
valasztasi-prediktor/
├── index.html                  # Alkalmazás belépési pont
├── css/
│   └── styles.css              # Teljes stíluslap (sötét téma, reszponzív)
├── js/
│   ├── app.js                  # Fő modul: UI összekötés, recalculate, event kezelés
│   ├── data.js                 # Adatlekérés (lokális cache / CORS proxy), normalizálás
│   ├── electoral-math.js       # Töredékszavazat, D'Hondt, küszöb, mandátumelosztás
│   ├── horseshoe.js            # Parlamenti patkó diagram (SVG)
│   ├── map.js                  # Interaktív SVG térkép (Mercator projekció)
│   ├── polling.js              # Wikipedia közvélemény-kutatás parser (MediaWiki API)
│   ├── prediction.js           # Felhasználói predikció állapotkezelés
│   └── utils.js                # Segédfüggvények, EventBus, pártszínek
├── data/
│   ├── party-mapping.json      # 2022→2026 pártmegfeleltetés konfiguráció
│   └── cache/                  # Letöltött API adatok (gitignore-olt)
└── .gitignore
```

## Licenc

MIT
