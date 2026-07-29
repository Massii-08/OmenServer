# Market Pulse — catalogue des sources locales par place boursière

> Sondé le 2026-07-29. **154 flux vivants** sur 15 places + 5 mécanismes transverses.
> Critère de rétention : `newest_age_h ≤ 48` — un flux qui répond 200 avec du XML valide peut
> être abandonné depuis des mois (mesuré : nl.investing.com **85 jours**, abmfn.nl **6 mois**).
> Chaque entrée a été sondée puis re-testée par un vérificateur adversarial ; un échantillon a été
> re-mesuré à la main (Handelsblatt 0,5 h · Les Échos 1,2 h · Tagesschau 3,7 h · Manager Magazin 0,5 h).

## Pièges de sondage — à lire avant d'ajouter une source

1. **200 + XML valide + items ≠ vivant.** Toujours lire la date du premier item.
2. **200 avec corps vide** (0 octet) — eleconomista.es avec un `category` obsolète.
3. **200 avec `<pubDate/>` auto-fermantes** : titres du jour mais fraîcheur non mesurable et tri
   impossible → inutilisable (eleconomista `rss-mercados.php`).
4. **Boucle de redirection infinie** : fuw.ch renvoie 302 vers lui-même.
5. **Le premier item n'est pas forcément le plus récent** : wallstreet-online ouvre sur une
   publicité sans date. Trier, ne jamais faire confiance à `items[0]`.
6. **Dates mal étiquetées** : ABC Bourse marque ses `pubDate` en « GMT » mais publie en heure de
   Paris → 2 h d'avance. Traiter comme `Europe/Paris`, sinon l'âge et le tri sont faux.
7. **⚠️ Toujours écrire dans un fichier temporaire NEUF par sonde.** En réutilisant `/tmp/f.xml`,
   une réponse 302 à corps vide laisse le contenu du flux PRÉCÉDENT et fabrique un faux positif —
   c'est arrivé pendant cette recherche (fuw.ch déclaré « vivant » avec le contenu de NZZ).

## Catalogue

### londra — Londres, Royaume-Uni | ^FTSE | Europe/London | ouvre 08:00
   The Guardian - Business            https://www.theguardian.com/uk/business/rss                    en   age=0.2h
   BBC News - Business                https://feeds.bbci.co.uk/news/business/rss.xml                 en   age=0.2h
   City AM                            https://www.cityam.com/feed/                                   en   age=0.2h
   This is Money                      https://www.thisismoney.co.uk/money/index.rss                  en   age=0.2h
   Financial Times - Markets          https://www.ft.com/markets?format=rss                          en   age=0.2h
   Financial Times - Home UK          https://www.ft.com/rss/home/uk                                 en   age=0.7h
   The Independent - Business         https://www.independent.co.uk/news/business/rss                en   age=0.3h
   The Telegraph - Business           https://www.telegraph.co.uk/business/rss.xml                   en   age=23.9h  [curl_cffi]
   Sky News - Business                https://feeds.skynews.com/feeds/rss/business.xml               en   age=22.3h
   Google News GB - site:reuters.com  https://news.google.com/rss/search?q=site:reuters.com+when:1d& en   age=0.4h
   Google News GB - FTSE 100          https://news.google.com/rss/search?q=FTSE+100+when:1d&hl=en-GB en   age=0.2h
   GNews: https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-GB&gl=GB&ceid=GB:en

### new_york — New York, Etats-Unis | ^GSPC | America/New_York | ouvre 09:30
   WSJ - Markets (NOUVEAU host Dow Jo https://feeds.content.dowjones.io/public/rss/RSSMarketsMain    en   age=0.0h
   WSJ - US Business (NOUVEAU host Do https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness  en   age=0.5h
   CNBC - Top News (id=100003114)     https://search.cnbc.com/rs/search/combinedcms/view.xml?partner en   age=0.2h
   Business Insider                   https://www.businessinsider.com/rss                            en   age=2.4h
   NYT - Business                     https://rss.nytimes.com/services/xml/rss/nyt/Business.xml      en   age=5.8h
   MarketWatch - Top Stories (SEUL fl https://feeds.marketwatch.com/marketwatch/topstories/          en   age=6.2h
   CNBC - Investing (id=15839069)     https://search.cnbc.com/rs/search/combinedcms/view.xml?partner en   age=7.9h
   Fortune                            https://fortune.com/feed/fortune-feeds/?id=3230629             en   age=8.0h
   Yahoo Finance                      https://finance.yahoo.com/news/rssindex                        en   age=15.6h
   Google News US - site:apnews.com ( https://news.google.com/rss/search?q=site:apnews.com+business+ en   age=0.6h
   Google News US - site:barrons.com  https://news.google.com/rss/search?q=site:barrons.com+when:2d& en   age=8.1h
   GNews: https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en

### toronto — Toronto, Canada | ^GSPTSE | America/Toronto | ouvre 09:30
   Financial Post                     https://financialpost.com/feed                                 en   age=0.5h
   Google News CA - TSX               https://news.google.com/rss/search?q=TSX+when:1d&hl=en-CA&gl=C en   age=0.2h
   Yahoo Finance Canada               https://ca.finance.yahoo.com/news/rssindex                     en   age=0.5h
   The Globe and Mail - Business (che https://www.theglobeandmail.com/arc/outboundfeeds/rss/category en   age=7.4h
   Financial Post - Investing         https://financialpost.com/category/investing/feed              en   age=11.3h
   CBC News - Business                https://www.cbc.ca/webfeed/rss/rss-business                    en   age=14.5h
   GNews: https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-CA&gl=CA&ceid=CA:en

### san_paolo — Sao Paulo, Bresil | ^BVSP | America/Sao_Paulo | ouvre 10:00
   Google News BR - Ibovespa          https://news.google.com/rss/search?q=Ibovespa+when:1d&hl=pt-BR pt-BR age=0.2h
   G1 - Economia                      https://g1.globo.com/rss/g1/economia/                          pt-BR age=1.7h
   Valor Economico (via syndication G https://pox.globo.com/rss/valor                                pt-BR age=1.9h
   Estadao - Economia                 https://www.estadao.com.br/arc/outboundfeeds/feeds/rss/section pt-BR age=6.1h
   InfoMoney (racine - PAS la rubriqu https://www.infomoney.com.br/feed/                             pt-BR age=6.9h
   InvestNews                         https://investnews.com.br/feed/                                pt-BR age=7.2h
   Valor Investe                      https://pox.globo.com/rss/valorinveste                         pt-BR age=7.7h
   Money Times                        https://www.moneytimes.com.br/feed/                            pt-BR age=8.9h
   Exame (pubDate ISO non-RFC822 - vo https://exame.com/feed/                                        pt-BR age=9.4h
   Seu Dinheiro                       https://www.seudinheiro.com/feed/                              pt-BR age=9.6h
   GNews: https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=pt-BR&gl=BR&ceid=BR:pt-419

### francoforte — Francfort, Allemagne | ^GDAXI | Europe/Berlin | ouvre 09:00
   Handelsblatt — Schlagzeilen        https://www.handelsblatt.com/contentexport/feed/schlagzeilen   de   age=0.1h
   Handelsblatt — Finanzen            https://www.handelsblatt.com/contentexport/feed/finanzen       de   age=0.2h
   Manager Magazin — Finanzen         https://www.manager-magazin.de/finanzen/index.rss              de   age=0.2h
   Finanzen.net — News                https://www.finanzen.net/rss/news                              de   age=0.0h  [curl_cffi]
   Tagesschau — Wirtschaft            https://www.tagesschau.de/wirtschaft/index~rss2.xml            de   age=0.6h
   wallstreet-online — toutes actus   https://www.wallstreet-online.de/rss/nachrichten-alle.xml      de   age=0.4h
   GNews: https://news.google.com/rss/search?q=DAX%20B%C3%B6rse&hl=de&gl=DE&ceid=DE:de

### parigi — Paris, France | ^FCHI | Europe/Paris | ouvre 09:00
   Les Échos — Marchés et indices (Fe https://feeds.feedburner.com/lesechos/4MR4suAcqTl              fr   age=0.3h
   Les Échos — Actualités valeurs (Fe https://feeds.feedburner.com/lesechos/BrFLB6ZLde7              fr   age=1.3h
   ABC Bourse — actualités (fuseau ma https://www.abcbourse.com/rss/displaynewsrss                   fr   age=0.2h
   BFM Business / BFMTV — Économie    https://www.bfmtv.com/rss/economie/                            fr   age=0.2h
   La Tribune — actualité             https://www.latribune.fr/rss/rubriques/actualite.html          fr   age=0.8h
   Le Figaro — Économie               https://www.lefigaro.fr/rss/figaro_economie.xml                fr   age=0.2h
   Les Échos — Finance & marchés (ori https://services.lesechos.fr/rss/les-echos-finance-marches.xml fr   age=0.4h  [curl_cffi]
   GNews: https://news.google.com/rss/search?q=CAC%2040%20Bourse&hl=fr&gl=FR&ceid=FR:fr

### amsterdam — Amsterdam, Pays-Bas | ^AEX | Europe/Amsterdam | ouvre 09:00
   Het Financieele Dagblad — flux pri https://fd.nl/?rss                                             nl   age=0.6h
   NU.nl — Economie                   https://www.nu.nl/rss/Economie                                 nl   age=0.6h
   NOS — Economie                     https://feeds.nos.nl/nosnieuwseconomie                         nl   age=1.8h
   Investing.com NL — nieuws          https://nl.investing.com/rss/news.rss                          nl   age=0.3h
   GNews: https://news.google.com/rss/search?q=AEX%20beurs&hl=nl&gl=NL&ceid=NL:nl

### madrid — Madrid, Espagne | ^IBEX | Europe/Madrid | ouvre 09:00
   Expansión — Mercados               https://e00-expansion.uecdn.es/rss/mercados.xml                es   age=0.3h
   Expansión — Portada                https://e00-expansion.uecdn.es/rss/portada.xml                 es   age=0.3h
   Cinco Días — Portada               https://feeds.elpais.com/mrss-s/pages/ep/site/cincodias.elpais es   age=0.4h
   Europa Press — Economía            https://www.europapress.es/rss/rss.aspx?ch=136                 es   age=0.1h
   El Economista — Economía           https://www.eleconomista.es/rss/rss-economia.php               es   age=11.8h  [curl_cffi]
   GNews: https://news.google.com/rss/search?q=Ibex%2035%20bolsa&hl=es&gl=ES&ceid=ES:es

### zurigo — Zurich, Suisse | ^SSMI | Europe/Zurich | ouvre 09:00
   Cash.ch — articles                 https://www.cash.ch/rss-article.xml                            de-CH age=0.1h
   NZZ — Wirtschaft                   https://www.nzz.ch/wirtschaft.rss                              de-CH age=0.7h
   SRF — Wirtschaft                   https://www.srf.ch/news/bnf/rss/1926                           de-CH age=2.4h
   Finanzen.ch — News                 https://www.finanzen.ch/rss/news                               de-CH age=0.2h  [curl_cffi]
   NZZ — Recent (généraliste, complém https://www.nzz.ch/recent.rss                                  de-CH age=0.4h
   GNews: https://news.google.com/rss/search?q=SMI%20B%C3%B6rse%20Schweiz&hl=de&gl=CH&ceid=CH:de

### tokyo — Tokyo, Japon | ^N225 | Asia/Tokyo | ouvre 09:00
   The Japan Times - flux principal   https://www.japantimes.co.jp/feed/                             en   age=0.8h
   Kyodo News (Japan Wire) - flux pri https://english.kyodonews.net/list/feed/rss4kyodonews-fzone    en   age=0.8h
   NHK - rubrique economie (cat5)     https://www.nhk.or.jp/rss/news/cat5.xml                        ja   age=0.1h
   Google News Japon - rubrique Busin https://news.google.com/rss/headlines/section/topic/BUSINESS?h ja   age=0.5h
   Nikkei Asia (RSS 1.0/RDF - AUCUNE  https://asia.nikkei.com/rss/feed/nar                           en   age=2.8h
   GNews: https://news.google.com/rss/search?q=Nikkei%20225%20Tokyo%20stocks%20when%3A1d&hl=en&gl=JP&ceid=JP:e

### hongkong — Hong Kong, Chine (RAS) | ^HSI | Asia/Hong_Kong | ouvre 09:30
   SCMP - Business                    https://www.scmp.com/rss/92/feed                               en   age=0.8h
   RTHK - Finance (anglais)           https://rthk.hk/rthk/news/rss/e_expressnews_efinance.xml       en   age=0.7h
   SCMP - Companies                   https://www.scmp.com/rss/10/feed                               en   age=0.9h
   SCMP - News (general Hong Kong)    https://www.scmp.com/rss/91/feed                               en   age=0.4h
   GNews: https://news.google.com/rss/search?q=Hang%20Seng%20index%20Hong%20Kong%20stocks%20when%3A1d&hl=en&gl

### shanghai — Shanghai, Chine | 000001.SS | Asia/Shanghai | ouvre 09:30
   SCMP - China                       https://www.scmp.com/rss/4/feed                                en   age=0.3h
   SCMP - Business (forte couverture  https://www.scmp.com/rss/92/feed                               en   age=0.8h
   Nikkei Asia (couverture Chine, AUC https://asia.nikkei.com/rss/feed/nar                           en   age=2.8h
   GNews: https://news.google.com/rss/search?q=Shanghai%20Composite%20China%20stocks%20when%3A1d&hl=en&gl=CN&c

### seoul — Seoul, Coree du Sud | ^KS11 | Asia/Seoul | ouvre 09:00
   The Korea Herald - Business        https://www.koreaherald.com/rss/kh_Business                    en   age=1.6h
   Yonhap News Agency - anglais       https://en.yna.co.kr/RSS/news.xml                              en   age=0.2h  [curl_cffi]
   The Korea Herald - toutes rubrique https://www.koreaherald.com/rss/newsAll                        en   age=0.9h
   GNews: https://news.google.com/rss/search?q=Kospi%20Korean%20shares%20when%3A1d&hl=en&gl=KR&ceid=KR:en

### sydney — Sydney, Australie | ^AXJO | Australia/Sydney | ouvre 10:00
   Sydney Morning Herald - Business   https://www.smh.com.au/rss/business.xml                        en   age=0.3h
   Australian Financial Review - Mark https://www.afr.com/rss/markets.xml                            en   age=1.5h
   ABC News - Business                https://www.abc.net.au/news/feed/51892/rss.xml                 en   age=0.2h
   Google News Australie - rubrique B https://news.google.com/rss/headlines/section/topic/BUSINESS?h en   age=0.6h
   GNews: https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-AU&gl=AU&ceid=AU:en

### mumbai — Mumbai, Inde | ^BSESN | Asia/Kolkata | ouvre 09:15
   The Economic Times - Markets       https://economictimes.indiatimes.com/markets/rssfeeds/19770215 en   age=0.5h
   Livemint - Markets                 https://www.livemint.com/rss/markets                           en   age=0.1h
   Business Standard - Markets        https://www.business-standard.com/rss/markets-106.rss          en   age=0.3h  [curl_cffi]
   Business Standard - Top stories    https://www.business-standard.com/rss/home_page_top_stories.rs en   age=0.5h  [curl_cffi]
   Google News Inde - rubrique Busine https://news.google.com/rss/headlines/section/topic/BUSINESS?h en   age=0.5h
   GNews: https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-IN&gl=IN&ceid=IN:en

### google_news_rss — Transverse — Google News RSS (news.google.com) |  | UTC | ouvre 
   Google News — DE rubrique Économie https://news.google.com/rss/headlines/section/topic/BUSINESS?h de   age=1.2h
   Google News — DE recherche 'Börse  https://news.google.com/rss/search?q=B%C3%B6rse+DAX+when:1d&hl de   age=0.1h
   Google News — FR rubrique Économie https://news.google.com/rss/headlines/section/topic/BUSINESS?h fr   age=0.9h
   Google News — FR recherche 'bourse https://news.google.com/rss/search?q=bourse+CAC+40+when:1d&hl= fr   age=0.2h
   Google News — ES recherche 'bolsa  https://news.google.com/rss/search?q=bolsa+IBEX+35+when:1d&hl= es   age=0.1h
   Google News — CH recherche 'Boerse https://news.google.com/rss/search?q=Boerse+SMI+when:1d&hl=de& de   age=0.2h
   Google News — NL recherche 'beurs  https://news.google.com/rss/search?q=beurs+AEX+when:1d&hl=nl&g nl   age=0.3h
   Google News — GB recherche 'FTSE 1 https://news.google.com/rss/search?q=FTSE+100+stock+market+whe en   age=0.1h
   Google News — GB rubrique Économie https://news.google.com/rss/headlines/section/topic/BUSINESS?h en   age=0.1h
   Google News — US recherche 'stock  https://news.google.com/rss/search?q=stock+market+when:1d&hl=e en   age=0.1h
   Google News — JP recherche '日経平均 株 https://news.google.com/rss/search?q=%E6%97%A5%E7%B5%8C%E5%B9% ja   age=0.1h
   Google News — JP rubrique Économie https://news.google.com/rss/headlines/section/topic/BUSINESS?h ja   age=0.5h
   Google News — HK recherche '恒生指數'  https://news.google.com/rss/search?q=%E6%81%92%E7%94%9F%E6%8C% zh-Hant age=0.6h
   Google News — AU recherche 'ASX 20 https://news.google.com/rss/search?q=ASX+200+when:1d&hl=en-AU& en   age=0.4h
   Google News — IN recherche 'Sensex https://news.google.com/rss/search?q=Sensex+Nifty+when:1d&hl=e en   age=0.3h
   Google News — opérateur site: (Les https://news.google.com/rss/search?q=site:lesechos.fr+when:1d& fr   age=0.1h
   Google News — opérateur site: (Han https://news.google.com/rss/search?q=site:handelsblatt.com+whe de   age=0.3h
   Google News — opérateur site: (Exp https://news.google.com/rss/search?q=site:expansion.com+when:1 es   age=1.3h
   CONTRÔLE POSITIF — ceid omis (facu https://news.google.com/rss/search?q=bourse+CAC+40+when:1d&hl= fr   age=0.2h
   GNews: https://news.google.com/rss/search?q=bourse+CAC+40+when:1d&hl=fr&gl=FR&ceid=FR:fr

### bing_news_rss — Transverse — Bing News RSS (www.bing.com) |  | UTC | ouvre 
   Bing News — DE 'Börse DAX'         https://www.bing.com/news/search?q=B%C3%B6rse+DAX&format=RSS&m de   age=20.2h
   Bing News — FR 'bourse CAC 40'     https://www.bing.com/news/search?q=bourse+CAC+40&format=RSS&mk fr   age=19.4h
   Bing News — ES 'bolsa IBEX 35'     https://www.bing.com/news/search?q=bolsa+IBEX+35&format=RSS&mk es   age=10.1h
   Bing News — CH 'Börse SMI'         https://www.bing.com/news/search?q=B%C3%B6rse+SMI&format=RSS&m de   age=10.4h
   Bing News — GB 'FTSE 100'          https://www.bing.com/news/search?q=FTSE+100&format=RSS&mkt=en- en   age=9.2h
   Bing News — US 'stock market'      https://www.bing.com/news/search?q=stock+market&format=RSS&mkt en   age=7.7h
   Bing News — JP '日経平均'              https://www.bing.com/news/search?q=%E6%97%A5%E7%B5%8C%E5%B9%B3 ja   age=7.1h
   Bing News — HK '恒生指數'              https://www.bing.com/news/search?q=%E6%81%92%E7%94%9F%E6%8C%87 zh-Hant age=19.4h
   Bing News — AU 'ASX 200'           https://www.bing.com/news/search?q=ASX+200&format=RSS&mkt=en-A en   age=12.3h
   Bing News — IN 'Sensex Nifty'      https://www.bing.com/news/search?q=Sensex+Nifty&format=RSS&mkt en   age=7.7h

### bluesky — Transverse — Bluesky (public.api.bsky.app, sans compte) |  | UTC | ouvre 
   Reuters (global, EN) — bsky        https://bsky.app/profile/reuters.com/rss                       en   age=0.1h
   Reuters Japan (JP) — bsky          https://bsky.app/profile/japan.reuters.com/rss                 ja   age=0.1h
   Nikkei 日経電子版 (JP) — bsky           https://bsky.app/profile/nikkei.com/rss                        ja   age=0.2h
   Nikkei Asia (JP/Asie, EN) — bsky   https://bsky.app/profile/asia.nikkei.com/rss                   en   age=0.3h
   WirtschaftsWoche (DE) — bsky       https://bsky.app/profile/wirtschaftswoche.bsky.social/rss      de   age=0.1h
   Les Echos (FR) — bsky              https://bsky.app/profile/lesechosfr.bsky.social/rss            fr   age=0.3h
   elEconomista (ES) — bsky           https://bsky.app/profile/eleconomista.es/rss                   es   age=0.0h
   NZZ (CH) — bsky                    https://bsky.app/profile/nzz.ch/rss                            de   age=0.0h
   Het Financieele Dagblad (NL) — bsk https://bsky.app/profile/fd.nl/rss                             nl   age=2.7h
   Financial Times (GB) — bsky        https://bsky.app/profile/financialtimes.com/rss                en   age=0.3h
   The Guardian (GB) — bsky           https://bsky.app/profile/theguardian.com/rss                   en   age=0.0h
   CNBC (US) — bsky                   https://bsky.app/profile/cnbc.com/rss                          en   age=0.6h
   Associated Press (US) — bsky       https://bsky.app/profile/apnews.com/rss                        en   age=0.4h
   Hong Kong Free Press (HK) — bsky   https://bsky.app/profile/hongkongfp.com/rss                    en   age=0.4h
   ABC News Australia (AU, généralist https://bsky.app/profile/news.abc.net.au/rss                   en   age=0.0h

### reddit — Transverse — Reddit RSS (www.reddit.com) |  | UTC | ouvre 
   r/eupersonalfinance (zone euro)    https://www.reddit.com/r/eupersonalfinance/.rss                en   age=23.6h
   r/investing (US/global)            https://www.reddit.com/r/investing/.rss                        en   age=4.0h
   r/Bogleheads (US)                  https://www.reddit.com/r/Bogleheads/.rss                       en   age=2.3h
   r/SecurityAnalysis (global, qualit https://www.reddit.com/r/SecurityAnalysis/.rss                 en   age=12.3h
   r/Finanzen (DE)                    https://www.reddit.com/r/Finanzen/.rss                         de   age=0.6h
   r/vosfinances (FR)                 https://www.reddit.com/r/vosfinances/.rss                      fr   age=10.9h
   r/JapanFinance (JP)                https://www.reddit.com/r/JapanFinance/.rss                     en   age=0.5h
   r/ASX_Bets (AU)                    https://www.reddit.com/r/ASX_Bets/.rss                         en   age=1.8h
   r/AusFinance (AU)                  https://www.reddit.com/r/AusFinance/.rss                       en   age=0.3h
   r/CanadianInvestor (CA)            https://www.reddit.com/r/CanadianInvestor/.rss                 en   age=4.9h
   r/IndiaInvestments (IN)            https://www.reddit.com/r/IndiaInvestments/.rss                 en   age=37.5h

### banques_centrales — Transverse — Banques centrales (BCE, Fed, BoE, BoJ, SNB, RBA) |  | UTC | ouvre 
   BCE — communiqués statistiques     https://www.ecb.europa.eu/rss/statpress.html                   en   age=46.8h
   BCE — taux de change de référence  https://www.ecb.europa.eu/rss/fxref-usd.html                   en   age=18.6h
   BoE — statistiques (le plus réguli https://www.bankofengland.co.uk/rss/statistics                 en   age=47.4h
   BoJ — nouveautés (anglais)         https://www.boj.or.jp/en/rss/whatsnew.xml                      en   age=8.0h
   BoJ — nouveautés (japonais, plus f https://www.boj.or.jp/rss/whatsnew.xml                         ja   age=5.7h
   SNB — nouveautés du site (le meill https://www.snb.ch/public/rss/en/news                          en   age=0.8h
   SNB — taux d'intérêt courants (QUO https://www.snb.ch/public/rss/en/interestRates                 en   age=20.8h
   SNB — cours de change courants (QU https://www.snb.ch/public/rss/en/exchangeRates                 en   age=20.8h
   SNB — AGENDA (dates FUTURES, âge n https://www.snb.ch/public/rss/en/events                        en   age=-12792.6h
   SNB — calendrier iCalendar 2026 (s https://www.snb.ch/public/ical/calendar/en/872f3023-70ea-42a9- en   age=-1.0h

