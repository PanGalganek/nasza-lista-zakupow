# Sprzęt laboratoryjny v38

## Model i granice transakcji

| Ścieżka | Dane |
| --- | --- |
| `equipmentState/cutover` | Brak znacznika oznacza tryb v37. Administrator ustawia `preparing`, `active` lub `paused`. Każdy z tych stanów blokuje zapis klienta do `wzorcowanie`. Zapis v38 działa w `active`. |
| `equipmentState/registry` | Rewizja rejestru, aktualizowana atomowo ze zmianą karty. Reguły wymagają zgodnej zmiany karty i rewizji. |
| `equipmentDevices/{device}` | Jedna karta ze stałym ID, opcjonalnym numerem, statusem, rewizją i maksymalnie 100 czynnościami. Każda zachowuje ID `a1…a100`, wyznaczane pozycją w zapisie. Format weryfikuje reguła. Reguła zabrania skracania listy. Wycofanie lub połączenie pozostawia kartę i powiązania. |
| `equipmentLinks/{sourceId}` | Przypisanie oryginalnego ID `wzorcowanie` do karty i czynności. Rozdzielenie tworzy kartę i aktualizuje powiązanie w jednej transakcji. |
| `equipmentYears/{year}` | Rewizja roku oraz wskaźniki zatwierdzonego planu i szkicu. |
| `equipmentYears/{year}/versions/{version}` | Rewizje wejściowe, deklarowana liczba wierszy i liczba zatwierdzonych wierszy. Każdy zapis dopisuje jeden wiersz oraz zwiększa licznik w tej samej partii. Tylko właściciel wersji może ją uzupełniać. |
| `equipmentYears/{year}/versions/{version}/rows/{device}:{activity}` | Niezmienny wiersz z maksymalnie 12 terminami. Reguły dopuszczają tylko wiersz wskazany przez bieżący krok zapisu. |
| `equipmentYears/{year}/results/{device}:{activity}:{term}` | Stan wykonania z oryginalnym planowanym miesiącem, datą rzeczywistą i uwagami. |
| `equipmentHistory/{operation}` | Niezmienny wpis dziennika z danymi sprzętu, stanem przed i po operacji oraz rokiem i miesiącem planu. |

Opublikowanie wersji atomowo zamyka ją i aktualizuje wskaźnik roku. Reguły wymagają zapisania wszystkich zadeklarowanych wierszy oraz niezmienionej rewizji rejestru. Kopiowanie sprawdza również rewizję i wersję planu źródłowego. Ponowienie na tym samym kluczu weryfikuje już zapisane wiersze i uzupełnia brakujące. Odhaczenie, korekta i cofnięcie atomowo aktualizują nagłówek, stan wykonania i dziennik.

### Macierz wywołań reguł

Poniższe górne granice zakładają, że każde wywołanie `get()`, `exists()` i `getAfter()` liczy się osobno. Zapis v38 zawsze zaczyna od dwóch wywołań, po konto i stan przełączenia. Odczyt klienta, np. `transaction.get()`, jest osobnym żądaniem odczytu. Kolumna „Łącznie” dolicza konserwatywnie jedno wywołanie na każdy dodatkowy element `verify` w końcowym żądaniu SDK. Maksimum to 10 na pojedynczą operację i 20 na żądanie wielodokumentowe. [Limity Cloud Firestore](https://firebase.google.com/docs/firestore/quotas) · [Odczyty w regułach](https://firebase.google.com/docs/firestore/security/rules-conditions)

| Operacja | Maksimum dla poszczególnych zapisów | Łącznie |
| --- | --- | ---: |
| Dodanie lub edycja karty, w tym 100 czynności | karta 4, rewizja rejestru 3 | 7 |
| Wycofanie lub przywrócenie karty | karta 4, rewizja rejestru 3 | 7 |
| Połączenie kart | karta źródłowa 5, docelowa 4, rewizja rejestru 3 | 12 |
| Zmiana przypisania pozycji źródłowej | powiązanie 4 | 4 |
| Rozdzielenie pozycji do nowej karty | karta 4, rewizja rejestru 3, powiązanie 4 | 11 |
| Otwarcie wersji szkicu, zatwierdzenia lub edycji | wersja 5 | 5 |
| Otwarcie kopiowania do pustego roku | wersja 5 | 5 |
| Zapis pojedynczego wiersza aktywnego | wiersz 4, postęp wersji 4 | 8 |
| Zapis wiersza nieaktywnego, odziedziczonego z planu lub szkicu | wiersz 6, postęp wersji 4 | 10 |
| Zapis wiersza kopiowanego | wiersz 5, postęp wersji 4 | 9 |
| Zapis lub zatwierdzenie kompletnej wersji i edycja planu | nagłówek 5, zamknięcie wersji 3, weryfikacja rewizji rejestru 1 | 9 |
| Finalizacja kopiowania | nagłówek 6, zamknięcie wersji 3, weryfikacja rejestru i roku źródłowego po 1 | 11 |
| Pierwsze odhaczenie | nagłówek 4, wynik 7, dziennik 5 | 16 |
| Korekta lub cofnięcie | nagłówek 4, wynik 6, dziennik 6 | 16 |
| Ponowne odhaczenie po cofnięciu | nagłówek 4, wynik 7, dziennik 6 | 17 |
| Odczyt karty, planu lub strony historii | sprawdzenie konta 1 | 1 na żądanie |
| Zapis starszego klienta przed przełączeniem lub jego odrzucenie po przełączeniu | sprawdzenie konta plus maks. 2 odczyty znacznika | 3 |

Bezpośredni zapis lub usunięcie historii, karty, wiersza w zamkniętej wersji i wyniku bez zdarzenia jest blokowany. W skrypcie administracyjnym obowiązują uprawnienia IAM, warunki istnienia dokumentów i kontrola wersji znacznika. Skrypt nie korzysta z uprawnień klienta aplikacji.

### Limity Spark, rozmiary i indeksy

- Plan o 85 wierszach i 1020 terminach kosztuje 173 zapisy dokumentów na wersję: otwarcie, 85 par wiersz–postęp i dwa końcowe zapisy. Największe żądanie aplikacji ma trzy zapisy dokumentów oraz ograniczoną liczbę odczytów. Kopiowanie sprawdza rejestr i źródłowy rok w stałym zakresie. Odhaczenie kosztuje trzy zapisy. Jedna strona historii pobiera do 40 zdarzeń.
- Szacunek dla badanego rozmiaru rejestru to ok. 270 odczytów dokumentów na pierwsze otwarcie z jedną wersją roku i kilkunastoma wynikami, przed odczytami potrzebnymi regułom. Pełny zapis lub kopiowanie wymaga rzędu 1000–1500 odczytów liczonych ostrożnie bez buforowania, przed ponowieniami. Wydajność pojedynczego dokumentu postępu i koszt nasłuchów zależą od obciążenia. Starsze wersje planów przechowują oddzielne wiersze i nie zwiększają rozmiaru nagłówka.
- Karta z 100 czynnościami pozostaje poniżej 100 KiB danych pól przy oszacowaniu czterech bajtów na znak oraz limitach tekstu. Pojedynczy wiersz zawiera do 12 tokenów. Rozmiary są wyraźnie poniżej 1 MiB na dokument i 10 MiB na żądanie. Tworzenie kolejnych wierszy składa się z osobnych żądań, a transakcja finalizacji ma limit 270 s.
- Historia wymaga dwóch indeksów `equipmentHistory`: `year ASC, at DESC` i `device ASC, at DESC`. Pole `equipmentDevices.activities` jest zwolnione z indeksowania, ponieważ jest odczytywane z karty. Spark zapewnia m.in. 50 tys. odczytów, 20 tys. zapisów dokumentów na dzień, 1 GiB danych i po 200 indeksów złożonych i konfiguracji pojedynczych pól bez rozliczeń. Kwoty dzielą wszystkie moduły. [Limity](https://firebase.google.com/docs/firestore/quotas) · [Indeksy](https://firebase.google.com/docs/firestore/query-data/indexing) · [Wydajność dokumentu](https://firebase.google.com/docs/firestore/best-practices)

## Procedura migracji po odrębnej zgodzie

Skrypt [equipment-v38-migrate.mjs](../scripts/equipment-v38-migrate.mjs) działa poza katalogiem publikowanym. Dla produkcji wymaga krótkotrwałego tokenu OAuth uprawnionego konta przekazanego przez `ELAB_FIRESTORE_ADMIN_TOKEN`. Weryfikuje projekt, typ bazy i wyłączone rozliczenia. Polecenia zapisujące wymagają `--confirm` z dokładnym identyfikatorem projektu. Testy zapisu uruchamia się na emulatorze loopback i z projektem `demo-*`. Kopie i opcjonalne przypisania zapisuje się poza Git.

1. Wykonać prywatną kopię i odtworzyć ją w emulatorze. Przeprowadzić `dry-run --backup <kopia>` oraz sprawdzić zakres migracji. Wstrzymać automatyczne ścieżki publikacji obu hostingów przed scaleniem, zachowując kontrole CI.
2. Opublikować zatwierdzone indeksy i poczekać na `READY`, następnie opublikować reguły. Poczekać na propagację. `freeze` sprawdza zgodność aktywnych reguł z plikiem i gotowość indeksów. Przy braku znacznika klient v37 może nadal zapisywać w sprzęcie. [Publikowanie reguł](https://firebase.google.com/docs/rules/manage-deploy)
3. Uzyskać potwierdzenie zapisania czynności z otwartych kart. Wykonać `freeze`, potem `capture --output <nowy plik>`. Kopia po zamrożeniu jest wymagana do dalszych kroków. Porównać ją z pierwszą kopią, żeby wychwycić równoległe zapisy. Przy zmianie zakresu zweryfikować ponownie manifest i ewentualne przypisania. Zmiany zakolejkowane offline po odrzuceniu przez blokadę rozliczyć z użytkownikiem.
4. Dla tej samej kopii wykonać `dry-run`, a potem `stage --backup <kopia po zamrożeniu>`. Opcjonalny `--mapping` musi być ten sam w każdym kroku przygotowania i aktywacji. Skrypt wiąże znacznik z hashem wszystkich pól `wzorcowanie` i pełnym manifestem nowych dokumentów. Zapisuje wyłącznie brakujące dokumenty docelowe warunkowo. Porównuje wszystkie ścieżki i pola w pełnej kopii przed i po, a niespodziewane zmiany źródła lub celu zatrzymują proces. Różnice w innych modułach raportuje oddzielnie do weryfikacji. Po przerwaniu ponowić dla tej samej kopii. Plan roczny 2026 wymaga osobnej zgody.
5. Opublikować oba frontendy w trybie `preparing`. Zweryfikować pliki i aktualizację PWA. Po pozytywnej kontroli uruchomić `activate --backup <ta sama kopia>`. Aktywacja ponownie weryfikuje indeksy, reguły, wartości źródeł i manifest celu. Stan zmienia się pod warunkiem zgodności wersji znacznika. Sprawdzić oba hostingi odczytowo, wykonać `audit --backup <ta sama kopia>` i przywrócić standardową automatyzację.
6. Przed aktywacją awaria pozostawia `preparing`; można uzupełnić przygotowanie i ponowić weryfikację bez otwierania zapisów v37. Po aktywacji użyć `pause`, zachować rozszerzone reguły i wszystkie dane. Zgodny frontend v38 umożliwia odczyt nowych wykonanych czynności. v37 może tymczasowo obsługiwać pozostałe moduły i pokazywać stary rejestr tylko do odczytu. Po naprawie i teście na nowej kopii użyć `resume`. Nigdy nie nadpisywać produkcji starą pełną kopią.

Każde polecenie wymaga argumentu `--project`. Polecenia `capture`, `dry-run` i `audit` wykonują wyłącznie odczyty. Plik porównania zapisuje się opcjonalnym `--output` poza Git. Na potrzeby testów można uruchomić [próbę integracyjną](../tests/equipment-release-rehearsal.mjs) w emulatorze `demo-elab-ui`, podając pełną prywatną kopię, kopię porównawczą i ścieżkę raportu. Próba używa wyłącznie lokalnego emulatora Firestore. Dla lokalnych odczytów po wyczyszczeniu testu źródło jest stabilne. Produkcyjny eksport stosuje wspólny czas odczytu wszystkich kolekcji.
