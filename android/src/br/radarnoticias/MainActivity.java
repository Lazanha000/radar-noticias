package br.radarnoticias;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import org.json.JSONObject;

// Abre o site do Radar; links de notícia vão para o navegador. A ponte "RadarApp" guarda os ajustes de
// notificação (o Vigia verifica em segundo plano) e o app se atualiza sozinho quando há APK novo no site.
public class MainActivity extends Activity {
    static final String SITE = "https://lazanha000.github.io/radar-noticias/";
    static final String INSTALOU = "br.radarnoticias.INSTALOU";
    WebView web;

    @Override
    protected void onCreate(Bundle salvo) {
        super.onCreate(salvo);
        getWindow().setStatusBarColor(0xFF081211);
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);  // ajustes, coleções e o que você segue
        web.addJavascriptInterface(new Ponte(), "RadarApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (u.toString().startsWith(SITE)) return false;
                abrir(u);
                return true;
            }
        });
        setContentView(web);
        if (salvo == null) web.loadUrl(SITE); else web.restoreState(salvo);
        Vigia.agendar(this);  // reagenda depois de atualizar o app
        if (salvo == null) new Thread(new Runnable() { public void run() { verificarAtualizacao(); } }).start();
    }

    void abrir(Uri u) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { /* nenhum app abre esse link */ }
    }

    // ---------- atualização automática ----------
    @SuppressWarnings("deprecation")
    void verificarAtualizacao() {
        try {
            JSONObject j = new JSONObject(Vigia.baixarTexto(SITE + "versao-apk.json?t=" + System.currentTimeMillis()));
            long tenho = getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
            if (j.getLong("versao") <= tenho) return;
            if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
                runOnUiThread(new Runnable() { public void run() {
                    Toast.makeText(MainActivity.this, "Há uma versão nova do Radar. Permita instalar apps desta fonte para atualizar.", Toast.LENGTH_LONG).show();
                    startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
                } });
                return;
            }
            runOnUiThread(new Runnable() { public void run() { Toast.makeText(MainActivity.this, "Baixando a versão nova do Radar…", Toast.LENGTH_SHORT).show(); } });
            PackageInstaller pi = getPackageManager().getPackageInstaller();
            int id = pi.createSession(new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL));
            try (PackageInstaller.Session s = pi.openSession(id)) {
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(SITE + j.getString("apk") + "?v=" + j.getLong("versao")).openConnection();
                try (java.io.InputStream in = c.getInputStream(); java.io.OutputStream out = s.openWrite("radar.apk", 0, -1)) {
                    byte[] b = new byte[65536];
                    for (int n; (n = in.read(b)) > 0; ) out.write(b, 0, n);
                    s.fsync(out);
                }
                int flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? 1 << 25 : 0);  // FLAG_MUTABLE: o sistema põe o status no intent
                android.app.PendingIntent p = android.app.PendingIntent.getActivity(this, 7,
                    new Intent(this, MainActivity.class).setAction(INSTALOU), flags);
                s.commit(p.getIntentSender());
            }
        } catch (Exception e) { /* sem internet ou sem versão nova: tenta na próxima abertura */ }
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        if (!INSTALOU.equals(i.getAction())) return;
        int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, -999);
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirmar = i.getParcelableExtra(Intent.EXTRA_INTENT);  // tela do Android "Atualizar este app?"
            if (confirmar != null) startActivity(confirmar.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } else if (st != PackageInstaller.STATUS_SUCCESS) {
            Toast.makeText(this, "Não deu para atualizar agora; tento de novo depois.", Toast.LENGTH_LONG).show();
        }
    }

    // ---------- ponte com o site ----------
    class Ponte {
        @JavascriptInterface public void salvarAlertas(String json) {
            getSharedPreferences("radar", MODE_PRIVATE).edit().putString("alertas", json).apply();
            Vigia.agendar(MainActivity.this);
        }
        @JavascriptInterface public String permissao() {
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED)
                return "negada";
            return getSystemService(android.app.NotificationManager.class).areNotificationsEnabled() ? "concedida" : "negada";
        }
        @JavascriptInterface public void pedirPermissao() {
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED)
                runOnUiThread(new Runnable() { public void run() { requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1); } });
            else if (!getSystemService(android.app.NotificationManager.class).areNotificationsEnabled())
                runOnUiThread(new Runnable() { public void run() { startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())); } });
        }
        @JavascriptInterface public void testar() {
            Vigia.notificar(MainActivity.this, "Radar Notícias · teste", "Assim chega um aviso de notícia relevante. Toque para abrir.", SITE, 1);
        }
        @JavascriptInterface public String versao() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return ""; }
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle b) {
        super.onSaveInstanceState(b);
        web.saveState(b);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
}
