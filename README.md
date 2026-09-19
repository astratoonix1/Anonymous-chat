# Signal — Unique ID Chat (Group + Private) with Telegram Forwarding

## Yeh kaise kaam karta hai
1. Koi bhi website kholta hai → server ek unique ID deta hai (jaise `7F3K-9QZP`).
2. Naam daalne ke baad menu aata hai: **Group Chat** ya **Private Chat**.
3. **Group Chat** — is waqt online sab users ek saath baat kar sakte hain.
4. **Private Chat** — kisi doosre ka ID daal kar sirf usi se connect hota hai.
5. **Cancel** button se wapas menu par aa sakte hain; private chat mein **Disconnect**
   button se donon side se connection khatam ho jata hai.
6. Page reload karne par bhi user usi ID/naam/chat state par wapas aata hai
   (browser ke localStorage se).
7. Har message — group ho ya private — turant Telegram bot/channel par forward
   hota hai. Server khud kabhi bhi message store nahi karta; forward hote hi
   memory se hata diya jata hai.

## Local mein chalane ke liye
```bash
npm install
cp .env.example .env   # apna TELEGRAM_BOT_TOKEN aur TELEGRAM_CHAT_ID daalein
npm start
```
Browser mein `http://localhost:3000` kholein.

## Render par deploy karne ke liye
1. Is folder ko GitHub repo mein push karein.
2. Render.com par **New → Web Service** banayein aur repo select karein.
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. **Environment** tab mein jaakar ye 2 variables add karein (`.env` file
   upload nahi karni, Render ke Environment Variables section mein daalein):
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
5. Deploy karein. Render aapko ek URL dega (jaise `https://yourapp.onrender.com`) —
   yahi link sabko bhejein, har koi apna alag unique ID paayega.

## Telegram Chat ID kaise nikalein
- Agar personal chat/group mein forward karna hai: bot ko us chat mein add
  karein, ek message bhejein, phir browser mein
  `https://api.telegram.org/bot<TOKEN>/getUpdates` kholein — usme `chat.id`
  dikhega.
- Channel ke liye: bot ko channel ka admin banayein, chat id usually
  `-100` se shuru hoti hai.

## Zaroori baat
- Chat history kahin bhi (database, file) save nahi hoti — sirf live delivery
  ke liye RAM mein hoti hai aur forward hote hi delete ho jaati hai. Agar
  server restart ho jaye, saare active connections aur unke chats bhi chale
  jaate hain (Telegram par jo forward ho chuka wahi record rahta hai).
- Free Render plan par service kuch der inactive rehne par so jaati hai —
  pehli request par dobara jaagne mein 20-30 second lag sakte hain.
