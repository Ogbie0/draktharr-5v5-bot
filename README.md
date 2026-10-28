# Draktharr — Discord 5v5 Özel Oyun Lobi & Draft Botu

Node.js (`node:sqlite`) ve `discord.js` v14 ile tek dosya (`bot.js` / `bot.cjs`) mimarisinde geliştirilmiş 5v5 özel maç lobi, oyuncu seçimi (draft), otomatik takım ses kanalları ve liderlik tablosu botu.

## Özellikler
- **5v5 Lobi & Koridor Seçimi:** Top Lane, Jungle, Mid Lane, ADC ve Support koridorlarına (her koridora 2 oyuncu) interaktif butonlarla katılma.
- **Kaptan & Otomatik Karşı Takıma Atamalı Draft:** Kaptanlar bir koridordan oyuncu seçtiğinde, aynı koridordaki diğer oyuncu otomatik olarak karşı takıma atanır.
- **Takım İsimleri & ANSI Renkli Görünüm:** Mavi (`🔵`) ve Kırmızı (`🔴`) takım renkleri, kaptanlar için kalın vurgu ve özel takım adı belirleme.
- **Otomatik Ses Kanalları:** Maç başladığında takım isimleriyle ses odaları açılır ve oyuncular taşınır; maç bittiğinde veya lobi kapandığında oyuncular ana lobi ses kanalına geri taşınır ve geçici odalar silinir.
- **+1 Win / -1 Lose Liderlik Tablosu & Geçmiş Maçlar:** SQLite veritabanı üzerinde kalıcı puanlama, oyuncu istatistikleri ve geçmiş maç kadroları.

## Kurulum ve Çalıştırma

1. Bağımlılıkları yükleyin (Node.js `>=22.5.0` / `>=24.x`):
   ```bash
   npm install
   ```
2. `.env.example` dosyasını `.env` olarak kopyalayıp `DISCORD_TOKEN` değerinizi girin:
   ```env
   DISCORD_TOKEN=BOT_TOKENINIZ
   ```
3. Botu başlatın:
   ```bash
   npm start
   ```
4. Test modunu çalıştırmak için:
   ```bash
   npm test
   ```

## Slash Komutları (12 Komut)
- `/lobi-kur` — Yeni bir 5v5 özel oyun lobisi oluşturur.
- `/deneme-lobisi-kur` — Hızlı test için botlarla dolu deneme lobisi kurar.
- `/lobi-kapat` — Aktif lobiyi veya seçilen kanaldaki lobiyi kapatır.
- `/takim-adi` — Mavi veya Kırmızı takımın adını değiştirir.
- `/oyuncu-cikar` — Aktif lobiden oyuncu çıkarır.
- `/aktif-lobiler` — Sunucudaki açık 5v5 lobileri listeler.
- `/gecmis-maclar` — Tamamlanan 5v5 maçları ve kadrolarını gösterir.
- `/liderlik-tablosu` — +1 Win / -1 Lose liderlik sıralamasını gösterir.
- `/liderlik-sifirla` — Liderlik tablosunu veya bir oyuncunun puanını sıfırlar.
- `/istatistik` — Oyuncunun 5v5 galibiyet, mağlubiyet ve sıralama istatistiklerini gösterir.
- `/rastgele-koridor` — Ses kanalındaki veya lobideki oyunculara rastgele 5 koridor dağıtır.
- `/yazi-tura` — Yazı tura atar.
