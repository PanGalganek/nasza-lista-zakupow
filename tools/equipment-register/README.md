
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
- **Harmonogram** — wybór roku, przygotowanie planu, zapis szkicu i zatwierdzenie. W tabeli każda czynność urządzenia ma osobny wiersz i 12 miesięcy. Na węższych ekranach wybierz jedno urządzenie i zaznacz miesiące na jego kartach. Liczniki obejmują cały rok, również przy aktywnych filtrach.

**Edytuj harmonogram** otwiera zapisany szkic lub aktualny zatwierdzony plan. Odznaczenie miesiąca anuluje niewykonany termin po zatwierdzeniu zmian. Przycisk **Przesuń** przenosi niewykonany termin do wolnego miesiąca ze stałym ID. Czynności zapisanej jako wykonana nie można przesunąć ani anulować. Data wykonania jest odrębna od miesiąca planowanego. Wycofane urządzenia zachowują terminy i pozostają widoczne w danym planie, a nowy aktywny sprzęt trafia do edytora z rejestru.

Sekcja **Harmonogram źródłowy** pokazuje pozycje z kopii wraz z rzeczywistymi datami wykonania. Wszystkie 86 pozycji i 13 dat zachowano poza planami rocznymi, ponieważ źródło nie zawiera wiarygodnego roku planu. Każdy nowy rok zaczyna się od pustego planu.

Przycisk **Uporządkuj przypisania** prowadzi do dotychczasowego kreatora. Można tam wyszukiwać, zatwierdzać, łączyć, rozdzielać i korygować pozycje. „Zapisz przypisania” aktualizuje wspólny rejestr. Można zapisywać niepełne przypisania i eksportować JSON z ich stanem weryfikacji. Jeśli w tej samej przeglądarce jest szkic poprzedniego kreatora, przy pierwszym uruchomieniu można go wczytać i zapisać jawnie, zanim emulator zawiera zapisane zmiany.

## Model prototypu

Niezmienna kopia źródłowa jest odczytywana przez serwer. Jeden dokument emulatora `lokalneRejestrySprzetu/{fingerprint}` zawiera numer rewizji i stan roboczy: mapowanie wszystkich źródeł oraz karty sprzętu ze stabilnymi identyfikatorami urządzeń i ich czynności. Wycofanie to zmiana statusu. Połączenie grup pozostawia wcześniejszą kartę w archiwum ze wskazaniem grupy docelowej.

Każdy rok otrzymuje dokument `lokalneRejestrySprzetu/{fingerprint}/plany/{rok}` z własną rewizją, szkicem i ostatnim zatwierdzonym planem. Termin zawiera stałe ID, ID urządzenia i czynności, miesiąc planowany oraz opcjonalną datę wykonania. Odwołania do urządzeń działają po zmianie ich nazw i numerów. Zapis szkicu pozostawia zatwierdzony plan dostępny dla innych klientów. Jeżeli wykonanie nastąpi po zapisaniu szkicu przesuwającego lub anulującego ten sam termin, wykonanie zachowuje pierwszeństwo, a pozostałe terminy szkicu pozostają dostępne.

Zapis jest warunkowany bieżącą rewizją i czasem ostatniej aktualizacji dokumentu Firestore. Każda zmiana atomowo zapisuje stan i jego poprzednią wersję w `historia/{operationId}` danego dokumentu. Powtórzenie żądania z tym samym identyfikatorem nie wykonuje czynności drugi raz. Otwarte okno zachowuje wpisane zmiany w razie konfliktu. Dwa różne lata i rejestr mają odrębne rewizje. Równoległe edycje kart w samym rejestrze nadal korzystają z jego wspólnej rewizji.

W przyszłym modelu produkcyjnym można rozdzielić agregat na dokumenty sprzętu i czynności, zachowując ich identyfikatory. Osobne pozycje roku powinny wskazywać identyfikator sprzętu i czynności oraz przechowywać historyczną nazwę, miesiąc i datę wykonania. Nie ma jeszcze produkcyjnej migracji ani reguł dla tych ścieżek.

## Testy

```powershell
node --test tools/equipment-register/register.test.mjs tools/equipment-register/registry.test.mjs tools/equipment-register/planner.test.mjs
npm test
npm run build
```

Test równoczesnych zapisów wymaga uruchomionego emulatora i zmiennych `GCLOUD_PROJECT=demo-elab-equipment-register` oraz `FIRESTORE_EMULATOR_HOST=127.0.0.1:18138`.
