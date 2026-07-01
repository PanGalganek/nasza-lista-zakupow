# e-Laboratorium

Wewnętrzna aplikacja laboratoryjna do obsługi odczynników i wzorców, harmonogramu badań, sprzętu oraz kalendarza. Kod jest przechowywany na GitHubie, a produkcja działa na Firebase Hosting z Firebase Authentication i Cloud Firestore.

## Wymagania

- Node.js 24
- Java 21 do testowania reguł Firestore
- Firebase CLI z dostępem do projektu `nasza-lista-zakupow` tylko przy ręcznym wdrożeniu

## Praca lokalna

```bash
npm ci
npm test
npm run build
npx firebase-tools@15.22.4 emulators:start --only hosting,firestore
```

Hosting emulatora: `http://127.0.0.1:5000`.

## Wdrożenie

Push do chronionej gałęzi `main` uruchamia testy i automatyczne wdrożenie Firebase Hosting oraz reguł Firestore przez GitHub Actions. Pull request otrzymuje siedmiodniowy kanał podglądowy Firebase Hosting.

Ręczne wdrożenie awaryjne:

```bash
npm ci
npm test
npx firebase-tools@15.22.4 deploy --only hosting,firestore:rules --project nasza-lista-zakupow
```

Reguły dostępu wymagają aktywnego dokumentu `app_users/{uid}` z rolą `admin` albo `operator`. Tych dokumentów nie można tworzyć z aplikacji klienckiej.
