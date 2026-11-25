# Bezpieczny rozwój e-Laboratorium

- Pracuj na osobnej gałęzi utworzonej z aktualnego `main`. Przed scaleniem sprawdź różnice względem `main` i wynik testów pull requesta.
- Przed zmianą, która może wpłynąć na dane, wykonaj i sprawdź aktualną kopię Firestore zgodnie z [procedurą kopii i odzyskiwania](docs/firestore-backup.md). Dotyczy to między innymi logiki zapisu i usuwania, schematu danych, reguł dostępu i migracji. Kopie, dane laboratoryjne i poświadczenia przechowuj poza repozytorium oraz poza artefaktami CI.
- Testuj zapis, usuwanie i odtwarzanie kopii wyłącznie lokalnie w emulatorze Firestore z identyfikatorem projektu `demo-`. Przed testem sprawdź, czy klient łączy się z emulatorem. Podgląd PR korzysta z produkcyjnego Firebase, więc ogranicz jego użycie do operacji odczytu.
- Uruchamiaj istniejące testy poleceniem `npm test`. Po zmianach frontendu sprawdzaj także kompilację poleceniem `npm run build`.
- Zachowuj zgodność z istniejącymi dokumentami, w tym starszymi rekordami, oraz z dotychczasowym działaniem aplikacji. Przy zmianach reguł uwzględnij poprzednią wersję PWA, która może pozostać otwarta u użytkowników.
- Po zmianie plików PWA przechowywanych w pamięci podręcznej aktualizuj spójnie nazwę pamięci podręcznej w service workerze, odwołania do skryptów w HTML i importach oraz listę plików w `APP_SHELL`. Sprawdź przejście z poprzedniej wersji.
- Przed scaleniem do `main` lub ręcznym wdrożeniem produkcyjnym uzyskaj wyraźną akceptację właściciela. Scalenie uruchamia publikację Firebase Hosting i GitHub Pages. Po zatwierdzonym wdrożeniu sprawdź oba zadania publikacji oraz dostępność aplikacji.
- Utrzymuj dodatkowy koszt na poziomie 0 zł. Nie przechodź na Blaze, nie podpinaj konta rozliczeniowego ani metody płatności i nie aktywuj płatnych usług.
- Przy awarii postępuj według [procedury wycofania aktualizacji](docs/rollback.md). Wybierz właściwą ścieżkę dla interfejsu, reguł Firestore albo danych.
