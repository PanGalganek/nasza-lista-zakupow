# Kopia danych Firestore

Kopia obejmuje rejestry e-Laboratorium, listę dostępu `app_users` oraz kolekcje magazynu, receptur, zamówień i obliczeń. Zachowuje identyfikatory dokumentów oraz format typów Firestore. Starszą kopię bez kolekcji magazynowych można odtworzyć w emulatorze. Konta Firebase Authentication, reguły i indeksy mają osobny cykl odzyskiwania. Reguły i indeksy są wersjonowane w Git.

## Wykonanie kopii

1. W konsoli Firebase sprawdź plan Spark i zużycie odczytów Firestore. Eksport zużywa zwykłą pulę odczytów. Najlepiej wykonać go przed zmianą danych lub reguł oraz okresowo, zależnie od liczby nowych wpisów.
2. Wybierz istniejący prywatny katalog poza repozytorium i katalogiem udostępnianym publicznie. Zaloguj się do Firebase CLI kontem z dostępem do odczytu dokumentów oraz informacji o rozliczeniach projektu.

   ```powershell
   npx firebase-tools@15.22.4 login
   npm exec --package=firebase-tools@15.22.4 -- node scripts/firestore-backup.mjs export 'C:\ścieżka\do\prywatnych-kopii'
   ```

3. Zachowaj plik JSON w katalogu dostępnym jedynie dla osób uprawnionych. Sprawdź, czy liczba dokumentów jest zbliżona do oczekiwanej. Skrypt kończy eksport błędem przy aktywnych rozliczeniach lub gdy nie może ich zweryfikować.

Przy lokalnie dostępnej instalacji Firebase CLI można ustawić `FIRESTORE_BACKUP_FIREBASE_CLI` na katalog pakietu `firebase-tools` i uruchomić polecenie bezpośrednio przez `node`.

## Próba odzyskania w emulatorze

Uruchom poniższe polecenia w osobnych oknach PowerShell. Pierwsze uruchamia emulator z identyfikatorem demonstracyjnym. Drugie odtwarza dokumenty przez adres pętli zwrotnej i zachowuje ich identyfikatory. Każdą próbę rozpocznij od świeżo uruchomionego emulatora. Istniejącego dokumentu skrypt nie nadpisze.

```powershell
npx firebase-tools@15.22.4 emulators:start --only firestore --project demo-elab-restore
```

```powershell
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
node scripts/firestore-backup.mjs restore-local 'C:\ścieżka\do\kopii.json'
```

W Emulator Suite UI, pod adresem wypisanym przez CLI, porównaj liczbę dokumentów, identyfikatory i kilka wartości z kopią. Po sprawdzeniu zatrzymaj emulator bez eksportowania jego stanu.

## Odzyskanie pojedynczych danych produkcyjnych

Po potwierdzeniu incydentu ustal, których dokumentów dotyczy. Zrób aktualną kopię i porównaj ją z ostatnią dobrą kopią. W konsoli Firestore przywróć wyłącznie utracone pola lub dokumenty, zachowując identyfikatory i typy. Zachowaj nowsze poprawne zmiany. Wpis `app_users` odnosi się do konkretnego UID. Przed przywróceniem takiego wpisu sprawdź, czy UID nadal należy do właściwego konta w Authentication i czy jego dostęp powinien być aktywny.

Jeśli problem dotyczy wielu dokumentów, ustal zakres na podstawie porównania i sprawdź plan w emulatorze przed zatwierdzeniem odzyskiwania. Próbę odtworzenia wykonuj wyłącznie lokalnie. Skrypt celowo zapisuje tylko do lokalnego projektu demonstracyjnego.
