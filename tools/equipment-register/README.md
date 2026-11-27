
# Lokalny kreator rejestru sprzętu

Kreator działa osobno od produkcyjnej PWA. Korzysta z pliku JSON kopii Firestore w formacie eksportu e-Laboratorium, zawierającego kolekcję `wzorcowanie`. Wymaga Node.js 24, który jest używany w projekcie. Sam kreator nie wymaga instalowania pakietów. Kopię i wyeksportowane przypisanie przechowuj poza repozytorium.

## Uruchomienie

W PowerShell, w katalogu repozytorium na gałęzi `codex/v38-equipment-register`:

```powershell
node .\tools\equipment-register\server.mjs "C:\sciezka\do\kopii-Firestore.json"
```

Otwórz [lokalny kreator](http://127.0.0.1:4388/). Zatrzymasz serwer klawiszami Ctrl+C. Jeśli port jest zajęty, dodaj inny numer po ścieżce do kopii. Żeby wrócić do szkicu, uruchom kreator na tym samym porcie, z tą samą kopią i otwórz go w tej samej przeglądarce.

## Praca ze szkicem

1. Otwórz „Przypisania”. Wyszukaj numer, nazwę urządzenia lub identyfikator pozycji. Etykieta „Zgodny numer” wskazuje propozycję opartą na ewidencji, a „Wymaga weryfikacji” oznacza wpis do sprawdzenia. Każda grupa wymaga zatwierdzenia.
2. W edytorze popraw proponowaną nazwę i numer. Na karcie pozycji widać oryginalną nazwę, typ, miesiąc i datę. „Rodzaj w rejestrze” oraz „Szczegóły czynności” służą do właściwego przypisania. Możesz np. zachować dwie czynności tego samego typu z różnymi opisami.
3. W sekcji „Połącz lub rozdziel grupę” wybierz grupę docelową i połącz całe grupy lub przenieś zaznaczone pozycje. Zaznaczenie części pozycji umożliwia wydzielenie nowej grupy. Połączenie zachowuje nazwę i numer grupy docelowej oraz wszystkie pozycje i przypisane czynności.
4. Sprawdzone grupy zatwierdź. Zmiana nazwy, numeru, czynności lub członkostwa grupy wymaga ponownej weryfikacji. Filtr „Tylko niezweryfikowane” pomaga dokończyć pracę. „Pozycje źródłowe” pokazują wszystkie rekordy, a „Podgląd rejestru” pokazuje proponowane urządzenia i czynności.
5. Użyj „Zapisz szkic”, aby wrócić do pracy później. Lokalny szkic jest przypisany do kopii i adresu kreatora w bieżącej przeglądarce. „Eksportuj przypisanie JSON” jest dostępne po zatwierdzeniu wszystkich pozycji i rozwiązaniu powtórzonych numerów. Plik zawiera proponowane urządzenia i czynności, powiązania z identyfikatorami źródłowymi oraz oryginalne pozycje. Brak pola typu pozostaje widoczny także w eksporcie.

Kreator udostępnia odczytane pozycje wyłącznie pod adresem pętli zwrotnej `127.0.0.1`. Nie łączy się z Firestore ani Firebase Auth. Zmiany szkicu pozostają w pamięci przeglądarki, a eksport tworzy oddzielny plik.

## Testy lokalne

```powershell
node --test tools/equipment-register/register.test.mjs
npm test
npm run build
```
