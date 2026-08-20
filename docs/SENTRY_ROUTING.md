# Sentry-meldroutering

`futur-control` is de enige plek die beslist of en wanneer een Sentry-fout een
beheermelding wordt. Sentry zelf stuurt geen e-mail, Slackbericht of pushmelding
naar beheerders.

## Ingang

- Webhook: `POST /api/webhooks/sentry`
- Vereist secret: `SENTRY_WEBHOOK_SECRET`
- Vereist daarnaast:
  - `SENTRY_ROUTING_SIGNING_SECRET`: hetzelfde willekeurige geheim van minimaal
    32 tekens als bij de FPS Connect API;
  - `SENTRY_DIRECT_API_PROJECT`: exact de Sentry-projectslug van de API.
- Ondersteunde Sentry-resources:
  - `event_alert`: registreert een foutvoorkomen;
  - `issue`: markeert `resolved` en `archived` als hersteld.
- De `Sentry-Hook-Signature` wordt met HMAC-SHA256 over de ongewijzigde request
  body gecontroleerd vóór de JSON-inhoud wordt gebruikt.

Het beheercentrum bewaart alleen issue-id, project, component, veilig
handelingslabel, omgeving, release, Sentry-link en tellers/tijdstippen. Vrije
fouttekst en gebruikerscontext worden niet overgenomen.

Sentry-webhooks zijn at-least-once. Iedere fout telt daarom uitsluitend mee
nadat de unieke Sentry-event-id atomair is geclaimd; een webhookretry kan nooit
het tweede voorkomen simuleren.

## Onderdrukking en classificatie

Een issue wordt pas meldbaar vanaf het **tweede voorkomen**. Een eenmalige fout
geeft dus geen beheermelding. Een `resolved` of `archived` issue wordt
onderdrukt. Een nieuw voorkomen ná herstel start als een nieuwe reeks bij één.

Alleen deze labels zijn direct:

- `POST:/api/auth/login`
- `POST:/api/auth/mobile/login`
- `POST:/api/uren`
- `PATCH:/api/uren/:id`
- `POST:/api/facturen/:id/verzenden-klant`
- `POST:/api/betaalbatches/:id/bevestigen`

Ieder ander of ontbrekend label gaat naar het dagbericht. De bronapplicaties
leveren alleen labels; zij leveren geen urgentie mee.

Een direct label is pas vertrouwd wanneer project, component, productieomgeving
én de API-HMAC over verwijzingscode plus label kloppen. Een clientevent uit een
publiek web- of mobiel project kan daardoor nooit een directe melding forceren.

## Tijden

Alle tijden worden in `Europe/Amsterdam` berekend:

- direct op werkdagen vanaf 07:15 tot 17:00;
- direct in het weekend vanaf 09:00 tot 17:00;
- overige actieve, herhaalde issues gebundeld om 17:00;
- buiten deze vensters geen melding.

De router loopt iedere minuut, gebruikt een PostgreSQL advisory lock tegen
dubbele uitvoering en markeert een issue pas als gemeld nadat het bestaande
beheercentrumkanaal de melding heeft geaccepteerd.

## Sentry-inrichting

1. Maak/gebruik afzonderlijke projecten voor API, Firevault en FPS Monteur.
2. Maak één interne integratie voor `futur-control` met issue- en
   issue-alertwebhooks.
3. Stel de webhook-URL hierboven in en bewaar hetzelfde signing secret alleen
   als productie-secret `SENTRY_WEBHOOK_SECRET`.
4. Laat de issue-alertactie relevante error-events aan deze integratie leveren.
   Rechtstreekse Sentry-notificatieacties naar personen of kanalen blijven uit.
5. Controleer met twee gebeurtenissen van hetzelfde testissue dat de
   herhaaldrempel en het juiste tijdvenster werken; los daarna het issue op en
   bevestig dat het niet meer wordt gemeld.