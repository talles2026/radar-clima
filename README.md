# Radar do Clima

Previsão do tempo por CEP ou cidade, otimizada para celular: https://talles2026.github.io/radar-clima/

- **Combina várias fontes**: 9 modelos globais (ECMWF, ECMWF IA, ICON, UKMO, Météo-France, GFS, GEM, JMA, CMA), MET Norway e CPTEC/INPE.
- **Chance de chuva por cenários**: 122 cenários dos conjuntos ECMWF, GEFS e ICON.
- **Aprende sozinho**: todo dia guarda o que cada modelo previu e compara com o que aconteceu; quem acerta mais ganha peso na região.
- **Se conserta sozinho**: cada fonte tem reservas; modelos que somem são trocados por equivalentes; um robô diário confere a saúde das fontes e corrige endereços e formatos.
- **Alertas**: oficiais do INMET (pelo polígono do aviso) e do próprio radar (temporal, chuva forte, vento, calor, geada, ar seco, chuva chegando).
- **No campo**: janelas de pulverização, secagem no terreiro e risco de geada.
- **Avisos no celular** (Web Push) e app instalável.

Servidor: função `clima` no Supabase (projeto `radar-clima`), código em `supabase/functions/clima/index.ts`.
