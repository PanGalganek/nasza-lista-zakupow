
# Lokalny rejestr sprzętu laboratoryjnego

Narzędzie działa obok produkcyjnej PWA. Do odczytania 86 pozycji źródłowych używa pliku JSON kopii Firestore w formacie e-Laboratorium. Rejestr zapisuje wyłącznie w emulatorze projektu `demo-elab-equipment-register`. Produkcyjna konfiguracja Firebase nie jest używana.

## Uruchomienie na Windows

Potrzebne są Node.js 24, Java 21 i Firebase CLI 15.22.4, używane także przez testy projektu. Otwórz PowerShell w katalogu repozytorium i wskaż plik kopii:

```powershell
$env:ELAB_EQUIPMENT_BACKUP = 'C:\sciezka\do\kopii-Firestore.json'
$stanSprzetu = Join-Path $env:LOCALAPPDATA 'e-Laboratorium/Rejestr-sprzetu-demo'
$opcjeSprzetu = @('--export-on-exit', $stanSprzetu)
if (Test-Path -LiteralPath (Join-Path $stanSprzetu 'firebase-export-metadata.json')) {
    $opcjeSprzetu += @('--import', $stanSprzetu)
}
npx --yes firebase-tools@15.22.4 emulators:exec --only firestore --project demo-elab-equipment-register --config tools/equipment-register/firebase.emulator.json @opcjeSprzetu 'node tools/equipment-register/server.mjs "%ELAB_EQUIPMENT_BACKUP%" 4388'
```

Otwórz [rejestr sprzętu](http://127.0.0.1:4388/). Serwer przyjmuje połączenia tylko z tego komputera. Zatrzymuj emulator przez Ctrl+C, aby zapisać stan wraz z historią poza repozytorium. Przy kolejnym uruchomieniu wskaż tę samą kopię źródłową i zachowaj ten sam katalog eksportu emulatora.

## Dwa panele

- **Rejestr sprzętu** — dodawanie, edycja, wycofywanie i przywracanie urządzeń. Numer ewidencyjny można dopisać później. Rodzaje czynności wybiera się z podpowiedzi lub wpisuje samodzielnie. Zmiana nazwy urządzenia albo rodzaju istniejącej czynności zachowuje jej identyfikator. Czynność można wyłączyć z planowania bez usuwania jej z karty.
- **Harmonogram** — podgląd aktywnych kart sprzętu z aktywnymi czynnościami. Uwzględnia dane z rejestru, także sprzęt bez numeru. Edytor planów rocznych pozostaje kolejnym etapem.

Przycisk **Uporządkuj przypisania** prowadzi do dotychczasowego kreatora. Można tam wyszukiwać, zatwierdzać, łączyć, rozdzielać i korygować pozycje. „Zapisz przypisania” aktualizuje wspólny rejestr. Można zapisywać niepełne przypisania i eksportować JSON z ich stanem weryfikacji. Jeśli w tej samej przeglądarce jest szkic poprzedniego kreatora, przy pierwszym uruchomieniu można go wczytać i zapisać jawnie, zanim emulator zawiera zapisane zmiany.

## Model prototypu

Niezmienna kopia źródłowa jest odczytywana przez serwer. Jeden dokument emulatora `lokalneRejestrySprzetu/{fingerprint}` zawiera numer rewizji i stan roboczy: mapowanie wszystkich źródeł oraz karty sprzętu ze stabilnymi identyfikatorami urządzeń i ich czynności. Wycofanie to zmiana statusu. Połączenie grup pozostawia wcześniejszą kartę w archiwum ze wskazaniem grupy docelowej.

Zapis jest warunkowany bieżącą rewizją i czasem ostatniej aktualizacji dokumentu Firestore. Jedna operacja zapisuje nowy stan oraz wpis poprzedniego stanu w `historia/{operationId}`. Żądanie ponowione z tym samym identyfikatorem nie wykonuje czynności drugi raz. Formularz otwarty w drugim oknie zachowuje treść w razie konfliktu, a rejestr utrzymuje wcześniej zaakceptowany zapis.

W przyszłym modelu produkcyjnym można rozdzielić agregat na dokumenty sprzętu i czynności, zachowując ich identyfikatory. Osobne pozycje roku powinny wskazywać identyfikator sprzętu i czynności oraz przechowywać historyczną nazwę, miesiąc i datę wykonania. Nie ma jeszcze produkcyjnej migracji ani reguł dla tych ścieżek.

## Testy

```powershell
node --test tools/equipment-register/register.test.mjs tools/equipment-register/registry.test.mjs
npm test
npm run build
```

Test równoczesnych zapisów wymaga uruchomionego emulatora i zmiennych `GCLOUD_PROJECT=demo-elab-equipment-register` oraz `FIRESTORE_EMULATOR_HOST=127.0.0.1:18138`.
