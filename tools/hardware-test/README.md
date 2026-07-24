# Windowsプリンター実機試験ツール

TM-T70IIへ固定fixtureを送信し、送信方式、状態取得、障害復旧を比較するCLIをここへ実装する。

初期比較対象:

- Windows Spooler RAW
- EpsonがTM-T70II向けに提供する利用可能な方式
- Debian既存環境の出力bytes・紙面

実機を接続するまで、送信方式や取得可能なstatusを確定扱いにしない。
