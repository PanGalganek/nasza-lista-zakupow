# Sprzęt laboratoryjny v38

## Model

| Ścieżka | Znaczenie |
|---|---|
| `equipmentState/cutover` | Znacznik przełączenia przygotowywany administracyjnie. Brak znacznika daje tryb v37. Stany `preparing`, `active` i `paused` blokują każdy zapis klienta do kolekcji źródłowej. W trybie `active` można zapisywać w v38, a `paused` pozwala czytać oba modele. |
| `equipmentDevices/{device}` | Karta ze stałym ID, opcjonalnym numerem, stanem, uwagami i rewizją. Wycofanie pozostawia kartę. Połączenie zachowuje archiwalną kartę i wskazanie karty docelowej. |
| `equipmentActivities/{device}:{activity}` | Osobny dokument czynności z niezmiennym kluczem, statusem i niezależną rewizją. |
| `equipmentLinks/{sourceId}` | Korygowane przypisanie oryginalnego ID `wzorcowanie` do karty i czynności. Podział może atomowo utworzyć kartę, czynność i powiązanie. |
| `equipmentYears/{year}` | Rewizja roku i wskaźniki zatwierdzonego planu oraz szkicu. |
| `equipmentYears/{year}/versions/{id}/rows/{device}:{activity}` | Niezmienne wiersze wersji. Wiersz ma maksymalnie 12 pól miesięcznych. Plan jest widoczny po atomowym zamknięciu wersji i zmianie wskaźnika. Niezakończona wersja pozostaje poza widokiem użytkownika. |
| `equipmentYears/{year}/results/{device}:{activity}:{term}` | Aktualny stan wykonania terminu. Dokument zachowuje pierwotny miesiąc, odrębną rzeczywistą datę i uwagi. |
| `equipmentHistory/{operation}` | Niezmienny wpis zdarzenia zawierający stan przed i po, rok i miesiąc planu oraz kopię nazwy, numeru i czynności z chwili zapisu. Dwa indeksy obsługują stronicowanie po roku i sprzęcie. |

Zapis wykonania zmienia w jednej transakcji stan terminu, rewizję roku i historię. Edycja planu tworzy wiersze nowej wersji w małych porcjach, a dopiero transakcja przełączająca wskaźnik udostępnia wersję. Równoległa zmiana roku przerywa zapis na podstawie starszej rewizji. Wykonania zawsze są widoczne niezależnie od wersji planu, nawet gdy operator zapisze kolejny układ terminów. Historia może rosnąć odrębnymi dokumentami zdarzeń.

Reguły wymagają istniejącego aktywnego konta `admin` lub `operator`. Sprawdzają kształt dokumentów, trwałe klucze, zakres i unikalność miesięcy w wierszu, wersje powiązane z bieżącą rewizją roku, granice pól, parę wykonanie–historia i równoczesną aktualizację nagłówka. Usuwanie dokumentów sprzętu, wersji, realizacji i historii jest niedostępne dla klientów. Przycisk „Kopiuj harmonogram” tworzy szkic tylko dla nieistniejącego roku; źródłem jest zatwierdzona wersja, a wykonania pozostają w poprzednim roku.

## Przygotowanie migracji i przełączenie

1. Wykonać świeży prywatny eksport i próbę odtworzenia według [procedury Firestore](firestore-backup.md). Na kopii ustalić stan oryginałów, liczbę wykonanych pozycji i ewentualne nowe rekordy. Użytkownik może zatwierdzić wstępne grupowanie częściowo, a brak numeru nie blokuje zapisu.
2. W emulatorze przygotować `equipmentDevices`, `equipmentActivities` i `equipmentLinks` na podstawie kopii i opcjonalnego pliku z kreatora przypisań. Skrypt w tej gałęzi jest ograniczony do loopbacku i projektu `demo-elab-ui`. Weryfikuje zbiór identyfikatorów, wartości i liczniki oraz bezpiecznie wznawia przygotowanie z tej samej kopii. Pozostawia dawne pozycje bez przypisanego roku.
3. Po osobnej akceptacji wdrożeniowej przygotować indeksy i reguły w środowisku docelowym. Obecny workflow publikuje Hosting i reguły. Indeksy z `firestore.indexes.json` trzeba opublikować oddzielnie i potwierdzić ich gotowość przed aktywacją. Przy braku znacznika pozostaje tryb dotychczasowy. Następnie zaufanym klientem administracyjnym ustawić `preparing`, potwierdzić zamrożenie zapisów `wzorcowanie` oraz wykonać odczyt po zamrożeniu. Jeśli wartości różnią się od kopii, ponownie zweryfikować zakres przygotowania przed aktywacją. Nie zmieniać oryginalnych ID, dat ani dokumentów `wzorcowanie`.
4. W trybie `preparing` przygotować nowe karty, czynności i linki w porcjach według identycznego manifestu zweryfikowanego lokalnie. Utworzyć brakujące dokumenty warunkowo oraz przerwać przy odmiennych wartościach. Potwierdzić kompletność wszystkich odniesień i brak wpisów rocznych utworzonych na podstawie roku wykonania. Użytkownik zatwierdza rzeczywisty rok odrębnie, tworząc właściwy plan.
5. Udostępnić v38 i sprawdzić odczyt w trybie przygotowania. Ustawić `active` warunkowo na zweryfikowanej wersji znacznika. Potwierdzić na obu hostingach działanie nowego interfejsu, brak możliwości zapisu starego klienta oraz odczyt oryginalnych danych. W próbach produkcyjnych używać tylko odczytów.

## Powrót awaryjny

- Przed przełączeniem lub po pojawieniu się nowych zapisów ustawić `paused` zaufanym klientem administracyjnym. Zachować aktualne reguły i blokadę starej kolekcji. Oryginały oraz nowe wyniki i historia nadal są dostępne do odczytu. Wersję PWA v37 można użyć tymczasowo dla innych modułów, a sprzęt pozostanie w niej archiwum tylko do odczytu.
- Przywrócić ostatni frontend zgodny z nowym modelem lub poprawić frontend v38. Przetestować go na świeżej kopii ze wszystkimi zmianami powstałymi od wdrożenia, zwłaszcza rewizjami roku i dziennikiem. Dopiero wtedy ustawić `active`.
- Jeżeli przerwano zapis wersji, pozostawiona otwarta wersja nie jest widoczna w planie. Powtórzenie tej samej operacji może uzupełnić brakujące wiersze. Można też rozpocząć nową edycję. Ewentualne sprzątanie osieroconych, otwartych wersji wymaga odrębnej operacji administracyjnej po sprawdzeniu wskaźników. Zatwierdzonych wersji, wyników i historii nie usuwać.

## Koszty i limity

Przy 77 kartach, 85 czynnościach, 86 powiązaniach, jednym planie z 85 wierszami i 13 wynikach otwarcie modułu kosztuje orientacyjnie **350 odczytów dokumentów**, plus dokumenty użyte przez reguły. Dodatkowe aktywne lata zwiększają ten koszt o liczbę ich wierszy i wyników przy pierwszym odczycie. W obrębie sesji wersje planów są buforowane, a moduł nasłuchuje metadanych roku tylko podczas otwarcia zakładki. Historia jest odczytywana na żądanie po maksymalnie **40 zdarzeń**.

Jedno odhaczenie, korekta lub cofnięcie to **3 zapisy atomowe** i szacunkowo **12–25 odczytów** włącznie z walidacją, przed ponowieniami, odświeżeniem widoku i aktualizacją pozostałych klientów. Zapis albo zatwierdzenie 85 wierszy to **87 zapisów dokumentów** i szacunkowo **700–1100 odczytów**, zależnie od cache, trybu kopiowania i odwołań reguł. Jest to estymacja dla typowego użycia, a nie pomiar zużycia produkcyjnego. Limity Firestore dzieli cała aplikacja.

Jeden wiersz ma 12 krótkich kluczy miesięcy i tokenów. Kartę ograniczają długości tekstu, zdarzenie przechowuje tylko jedną zmianę, a nagłówek roku przechowuje wskaźniki. Limity budżetu są znacznie powyżej rozmiarów tych dokumentów: **1 MiB** na dokument, **10 MiB** na żądanie oraz **270 s** na transakcję. Reguły pozwalają na maksymalnie **10 wywołań odczytu zależnego na operację** i **20 w ramach transakcji lub partii**. Spark daje **50 tys. odczytów** i **20 tys. zapisów dziennie**. [Limity Firestore](https://firebase.google.com/docs/firestore/quotas) [Zasady rozliczeń i odczytów w regułach](https://firebase.google.com/docs/firestore/pricing)

## Podgląd lokalny

Użyć emulatorów Auth i Firestore dla projektu `demo-elab-ui`. Wskazać prywatny plik kopii JSON w `ELAB_EQUIPMENT_BACKUP`, opcjonalnie plik eksportu przypisań w `ELAB_EQUIPMENT_MAPPING`, a następnie uruchomić w emulatorach `node scripts/ui-preview.mjs`. Przykładowe konto jest generowane lokalnie. Konfiguracja demonstracyjna nie należy do publikowanych plików.
