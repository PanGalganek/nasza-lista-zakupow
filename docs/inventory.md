# Magazyn odczynników i wzorców

Rejestr zachowuje historyczne identyfikatory w `odczynniki`. Po otrzymaniu dostawy dodaj partię. Formularz pozwala wprowadzić stan przyjęty, a przy braku osobnej wartości przyjmuje podaną wielkość opakowania. Dla wcześniej zapisanych partii użyj „Ustal stan”. Operacja zapisuje bilans otwarcia z bieżącą datą. Ilość początkową oraz numer partii sprawdza użytkownik.

## Dane i zgodność wsteczna

- Dokumenty `odczynniki` przechowują dotychczasowe dane partii oraz opcjonalne dane zakupowe i `productId`. Identyfikator produktu wskazuje na wybraną pozycję istniejącego rejestru. Starsza pozycja bez powiązania pozostaje osobnym wariantem. Identyczne warianty można powiązać w edycji starszej partii przed ustaleniem jej stanu, jeżeli nie została już powiązana z innymi zapisami.
- `magazyn_partie` zawiera stany pod identyfikatorami partii. `magazyn_operacje` zawiera nieusuwalną historię, w tym migawki przygotowań i osobne korekty.
- `magazyn_receptury` i `magazyn_metody` zawierają konfigurację. `magazyn_obliczenia` przechowuje wyłącznie zapisane wyniki teoretyczne, a `magazyn_zamowienia` przechowuje treść i status wygenerowanych zamówień.
- Ilości masy i objętości zapisują się odpowiednio w mikrogramach i nanolitrach. Sztuki i testy mają jednostki całkowite. Liczba poniżej rozdzielczości magazynu blokuje zapis. Kalkulator teoretyczny zaokrągla na końcu do jednostki bazowej. Rozchód magazynowy wymaga dokładnej wartości całkowitej.
- Zapisy są atomowe i obejmują do ośmiu partii na jedną operację. Lista składników receptury nie ma tego ograniczenia. Dla przygotowania przekraczającego granicę zapis zostaje odrzucony w całości. Granicę wyznacza budżet sprawdzeń reguł Firestore. Korekta rozchodu na zamkniętej partii wymaga decyzji o dalszym postępowaniu poza zwykłą ścieżką cofania.

## Publikacja i odzyskiwanie

1. Przed zatwierdzonym wydaniem wykonaj [kopię Firestore](firestore-backup.md). W emulatorze sprawdź odtworzenie kopii, odczyt starszych rekordów i operacje magazynowe.
2. Wersja aplikacji i reguły Firestore powinny trafić do tego samego wydania. Nie ma skryptu migracji produkcyjnej. Odczyt starszego rekordu działa w istniejącym formacie, a jego stan ilościowy powstaje przy jawnej czynności użytkownika. Stare PWA może odczytać i edytować rekord, ale reguły blokują trwałe usuwanie.
3. Po wydaniu sprawdź dostępność aplikacji i aktualizację PWA. Podgląd pull requesta korzysta z produkcyjnego Firebase.
4. W przypadku awarii postępuj zgodnie z [procedurą wycofania](rollback.md). Jeżeli aplikacja zdążyła już zapisać operacje magazynowe, zachowaj nową konfigurację zapobiegającą trwałemu usuwaniu. Stare reguły walidacji nie rozpoznają nowych pól odczynników.

## Zamówienia

Generator tworzy osobny edytowalny DOCX z samą tabelą. Data, nazwa, ilość opakowań i opcjonalne uwagi odpowiadają kolumnom 2, 3, 4 i 11. „Dostawca” oraz „Numer zamówienia” zawsze pozostają puste. Weryfikację i wklejenie przygotowanych wierszy wykonuje użytkownik w Wordzie. Wygenerowanie pliku zapisuje historię. Status „Zamówiono” ustawia się osobno.
