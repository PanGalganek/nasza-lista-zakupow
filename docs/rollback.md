# Wycofanie aktualizacji e-Laboratorium

## Przed wydaniem

1. Zapisz identyfikator ostatniej działającej wersji i sprawdź, czy `verify` przeszedł dla nowej zmiany. Przed zmianą logiki zapisu, usuwania lub reguł zrób [kopię Firestore](firestore-backup.md).
2. Podgląd pull requesta korzysta z produkcyjnego Firebase. Ogranicz próbę na tym adresie do odczytu. Przypadki zapisu sprawdzaj w testach automatycznych lub lokalnym emulatorze.
3. Po zatwierdzonej publikacji sprawdź wyniki zadań `deploy` i `pages` w GitHub Actions. Otwórz adres Firebase Hosting, używany adres GitHub Pages oraz zainstalowaną PWA. Sprawdź logowanie i widok zmienionej funkcji.

## Gdy wydanie powoduje problem

1. Wstrzymaj kolejne publikacje. Ustal, czy problem dotyczy interfejsu, reguł dostępu lub danych.
2. **Interfejs.** Gdy potrzebne jest szybkie przywrócenie Firebase Hosting, wybierz poprzednie sprawne wydanie w sekcji Hosting w konsoli Firebase i użyj opcji Rollback. Aby utrwalić cofnięcie na obu adresach, przygotuj commit `revert` w osobnym PR-ze do `main`. Po zatwierdzeniu i scaleniu obecny workflow opublikuje cofnięty kod na Firebase Hosting i GitHub Pages.
3. **Reguły Firestore.** Przywróć sprawdzoną wersję `firestore.rules` przez zatwierdzony PR do `main` i sprawdź wynik wdrożenia. Cofnięcie w konsoli Hostingu dotyczy wyłącznie Hostingu.
4. **Dane.** Użyj [procedury odzyskiwania Firestore](firestore-backup.md#odzyskanie-pojedynczych-danych-produkcyjnych). Cofnięcie kodu pozostawia dokumenty w stanie zapisanym w bazie.
5. Zweryfikuj poprawkę na obu adresach i w zainstalowanej PWA. Jeśli karta nadal pokazuje wadliwą wersję, zamknij wszystkie okna aplikacji i otwórz ją ponownie. Potwierdź działanie przed wznowieniem zapisów, jeśli usterka dotyczyła danych.

Po uruchomieniu magazynu nie wycofuj całego commita magazynowego na produkcji. Poprzednie reguły dopuszczały trwałe usuwanie i nie rozpoznawały nowych pól. Cofnij tylko frontend w Firebase Hosting, a dla obu adresów przygotuj oddzielną poprawkę frontendu z utrzymaniem reguł magazynu. Przed publikacją przećwicz zgodność tej pary w emulatorze. W razie niespójności zabezpiecz aktualną kopię i wstrzymaj zapisy do czasu diagnozy, zachowując wszystkie poprzednie dokumenty i operacje.
