#!/bin/bash
# monta o APK sem Gradle/Android Studio: aapt2 -> javac -> d8 -> zipalign -> apksigner
# uso: bash android/build.sh
#  - gera android/radar.apk com versão nova (data e hora)
#  - copia para site/ e anota site/versao-apk.json: depois do git push, o app no celular se atualiza sozinho
#  - copia também para Sistema Digital/Aplicativos/Android (Syncthing)
set -e
cd "$(dirname "$0")"
PY="$LOCALAPPDATA/Programs/Python/Python312/python.exe"
P="$LOCALAPPDATA/Programs"
export JAVA_HOME="$P/jdk17/jdk-17.0.21+9" PATH="$P/jdk17/jdk-17.0.21+9/bin:$PATH"
BT="$P/android-sdk/build-tools/34.0.0" JAR="$P/android-sdk/platforms/android-34/android.jar"
VC=$(date +%y%m%d%H%M | cut -c1-9)   # ex.: 261118143 (cabe no int do Android)
sed -i -E "s/android:versionCode=\"[0-9]+\" android:versionName=\"[^\"]*\"/android:versionCode=\"$VC\" android:versionName=\"2.$VC\"/" AndroidManifest.xml
rm -rf out && mkdir -p out/classes out/gen

# ícone: o radar da marca (disco, anéis, mira, varredura e dois pontos)
"$PY" -c "
from PIL import Image, ImageDraw
S=4; s=192*S; im=Image.new('RGBA',(s,s),(0,0,0,0)); d=ImageDraw.Draw(im)
d.rounded_rectangle((0,0,s-1,s-1),42*S,fill='#06110f')
c=s//2; R=70*S; ci=(47,227,223,255)
d.ellipse((c-R,c-R,c+R,c+R),fill='#0b2a28')
cam=Image.new('RGBA',(s,s),(0,0,0,0)); dc=ImageDraw.Draw(cam); dc.pieslice((c-R,c-R,c+R,c+R),-62,-28,fill=(47,227,223,140)); im.alpha_composite(cam)
for r,w in ((R,7),(46*S,6),(22*S,6)): d.ellipse((c-r,c-r,c+r,c+r),outline=ci,width=w*S)
d.line((c,c-R,c,c+R),fill=ci,width=4*S); d.line((c-R,c,c+R,c),fill=ci,width=4*S)
for x,y,r in ((c+26*S,c-50*S,8*S),(c-34*S,c-30*S,7*S)): d.ellipse((x-r,y-r,x+r,y+r),fill='#effffe')
im.resize((192,192),Image.LANCZOS).save('res/mipmap/ic_launcher.png')"

"$BT/aapt2" compile --dir res -o out/res.zip
"$BT/aapt2" link -o out/base.apk -I "$JAR" --manifest AndroidManifest.xml out/res.zip --java out/gen --min-sdk-version 24 --target-sdk-version 34 --auto-add-overlay
javac -source 8 -target 8 -bootclasspath "$JAR" -nowarn -Xlint:-options -d out/classes src/br/radarnoticias/*.java out/gen/br/radarnoticias/R.java
"$BT/d8.bat" --release --lib "$JAR" --min-api 24 --output out $(find out/classes -name "*.class")
"$PY" -c "import zipfile; zipfile.ZipFile('out/base.apk','a').write('out/classes.dex','classes.dex')"
"$BT/zipalign.exe" -f -p 4 out/base.apk out/alinhado.apk

# shortcut: chave no padrão "debug" do Android (senha pública), serve para instalar por fora da Play Store; para publicar na loja, gerar chave própria
[ -f radar-noticias.keystore ] || keytool -genkeypair -keystore radar-noticias.keystore -storepass android -keypass android -alias radar \
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Radar" >/dev/null 2>&1
"$BT/apksigner.bat" sign --ks radar-noticias.keystore --ks-pass pass:android --out radar.apk out/alinhado.apk
"$BT/apksigner.bat" verify radar.apk && ls -la radar.apk

cp radar.apk ../site/radar.apk
printf '{"versao": %s, "apk": "radar.apk"}\n' "$VC" > ../site/versao-apk.json
"$PY" ../../publicar_apk.py radar.apk br.radarnoticias "$VC" || echo "(aviso: não copiei para Aplicativos/Android)"
