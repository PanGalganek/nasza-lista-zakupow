# Magazyn odczynników i wzorców

Rejestr zachowuje historyczne identyfikatory w `odczynniki`. Po otrzymaniu dostawy dodaj partię. Formularz pozwala wprowadzić stan przyjęty, a przy braku osobnej wartości przyjmuje podaną wielkość opakowania. Dla wcześniej zapisanych partii użyj „Ustal stan”. Operacja zapisuje bilans otwarcia z bieżącą datą. Ilość początkową oraz numer partii sprawdza użytkownik.

## Dane i zgodność wsteczna

- Dokumenty `odczynniki` przechowują dotychczasowe dane partii oraz opcjonalne dane zakupowe i `productId`. Identyfikator produktu wskazuje na wybraną pozycję istniejącego rejestru. Starsza pozycja bez powiązania pozostaje osobnym wariantem. Identyczne warianty można powiązać w edycji starszej partii przed ustaleniem jej stanu, jeżeli nie została już powiązana z innymi zapisami.
- `magazyn_partie` zawiera stany pod identyfikatorami partii. `magazyn_operacje` zawiera nieusuwalną historię, w tym migawki przygotowań i osobne korekty.
- `magazyn_receptury` i `magazyn_metody` zawierają konfigurację. `magazyn_obliczenia` przechowuje wyłącznie zapisane wyniki teoretyczne, a `magazyn_zamowienia` przechowuje treść i status wygenerowanych zamówień.
- Ilości masy i objętości zapisują się odpowiednio w mikrogramach i nanolitrach. Sztuki i testy mają jednostki całkowite. Liczba poniżej rozdzielczości magazynu blokuje zapis. Kalkulator teoretyczny zaokrągla na końcu do jednostki bazowej. Rozchód magazynowy wymaga dokładnej wartości całkowitej.
- Zapisy są atomowe i obejmują do ośmiu partii na jedną operację. Lista składników receptury nie ma tego ograniczenia. Dla przygotowania przekraczającego granicę zapis zostaje odrzucony w całości. Granicę wyznacza budżet sprawdzeń reguł Firestore. Korekta rozchodu na zamkniętej partii wymaga decyzji o dalszym postępowaniu poza zwykłą ścieżką cofania.

## Publikacja i odzyskiwanie

1. Przed zatwierdzonym wydaniem wykonaj [kopię Firestore](firestore-backup.md), sprawdź sumę kontrolną i przećwicz odtworzenie w emulatorze. Porównaj źródło z aktualnym `main` i zapisz identyfikator poprzedniego sprawnego wydania.
2. Po akceptacji opublikuj wersję aplikacji i reguły Firestore w jednym wydaniu. Stan ilościowy powstaje przy jawnej czynności użytkownika. Nie ma migracji masowej: nie uzupełniaj stanów domyślnie i nie importuj danych z emulatora. Stare PWA może odczytać i edytować rekord. Reguły blokują trwałe usuwanie.
3. Po wydaniu sprawdź oba zadania publikacji, dostępność, logowanie i aktualizację PWA z poprzedniej wersji przy zwykłym ponownym wejściu. Na produkcji sprawdzaj wyłącznie odczyt, do pierwszego zatwierdzonego użycia magazynu. Podgląd pull requesta korzysta z produkcyjnego Firebase.
4. W przypadku awarii postępuj zgodnie z [procedurą wycofania](rollback.md). Zachowaj nowe reguły ochrony danych i historię magazynu. Przed zatwierdzonym cofnięciem sprawdź w emulatorze współpracę starego frontendu z aktualnymi regułami i danymi.

## Odczyty i praca bez połączenia

Po zalogowaniu moduł obserwuje rejestr, stany, metody i receptury. Historia operacji, zamówienia i obliczenia są podłączane przy pierwszym użyciu. Filtry i wyszukiwanie korzystają z danych w pamięci. Wznowienie połączenia może ponownie obciążyć pulę odczytów.

Przy rozchodzie z N partii transakcja wykonuje nominalnie 1 + 2N odczytów dokumentów i N + 1 zapisów. Przyjęcie N nowych samodzielnych partii wykonuje jeden odczyt identyfikatora operacji i 2N + 1 zapisów. Powiązanie z istniejącą pozycją, odczyty zależne od reguł oraz ponowienia transakcji zmieniają faktyczną liczbę. Monitoruj panel Firestore Usage na planie Spark.

Operacje magazynowe wymagają połączenia. W otwartej karcie można korzystać z już odczytanych danych i kalkulatora teoretycznego. Zimny start i synchronizacja całego rejestru offline zależą od dostępności SDK i sesji. Aplikacja nie włącza trwałego lokalnego zapisywania danych laboratoryjnych.

## Zamówienia

Generator tworzy osobny edytowalny DOCX z samą tabelą. Data, nazwa, ilość opakowań i opcjonalne uwagi odpowiadają kolumnom 2, 3, 4 i 11. „Dostawca” oraz „Numer zamówienia” zawsze pozostają puste. Weryfikację i wklejenie przygotowanych wierszy wykonuje użytkownik w Wordzie. Wygenerowanie pliku zapisuje historię. Status „Zamówiono” ustawia się osobno.
