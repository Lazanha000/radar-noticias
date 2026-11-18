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
        String hash = hashDe(getIntent());
        criarWeb(SITE + (hash != null ? "#" + hash : ""));
        try { Vigia.agendar(this); } catch (Throwable e) { Radar.registrar(this, "agendar alertas", e); }  // reagenda depois de atualizar o app
        new Thread(new Runnable() { public void run() {
            try { verificarAtualizacao(); } catch (Throwable e) { Radar.registrar(getApplicationContext(), "verificar atualização", e); }
            try { WidgetPrincipais.baixarEAtualizar(getApplicationContext()); } catch (Throwable e) { Radar.registrar(getApplicationContext(), "widget", e); }
        } }).start();
    }

    /** Cria o WebView. Também é chamado quando o sistema mata o processo da página para liberar memória
     *  (Xiaomi faz muito isso): sem tratar, o Android fecha o app inteiro com "o app parou". */
    void criarWeb(String url) {
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

            @Override
            public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail d) {
                Radar.registrar(MainActivity.this, "a página foi fechada pelo sistema (" + (d.didCrash() ? "travou" : "falta de memória")
                    + "); recarreguei", new Exception("WebView render process gone"));
                String onde = SITE;
                try { String u = v.getUrl(); if (u != null && u.startsWith(SITE)) onde = u; } catch (Throwable e) { }
                if (v == web) {
                    ((android.view.ViewGroup) v.getParent()).removeView(v);
                    v.destroy();
                    criarWeb(onde);
                } else v.destroy();
                return true;  // tratado: o app continua aberto
            }
        });
        setContentView(web);
        web.loadUrl(url);
    }

    /** Atalhos do ícone e widgets abrem "radar:busca", "radar:colecao/ID"... */
    static String hashDe(Intent i) {
        Uri u = i == null ? null : i.getData();
        return u != null && "radar".equals(u.getScheme()) ? u.getSchemeSpecificPart() : null;
    }

    void abrir(Uri u) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { /* nenhum app abre esse link */ }
    }

    /** startActivity que não derruba o app (algumas telas do sistema não existem em todo Android, ex.: Xiaomi). */
    void abrirTela(Intent i) {
        try { startActivity(i); } catch (Throwable e) { Radar.registrar(this, "abrir tela " + i.getAction(), e); }
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
                    abrirTela(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
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
        String hash = hashDe(i);
        if (hash != null && web != null) { web.evaluateJavascript("window.radarAbrir && radarAbrir(" + JSONObject.quote(hash) + ")", null); return; }
        if (!INSTALOU.equals(i.getAction())) return;
        int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, -999);
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirmar = i.getParcelableExtra(Intent.EXTRA_INTENT);  // tela do Android "Atualizar este app?"
            if (confirmar != null) abrirTela(confirmar.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
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
                runOnUiThread(new Runnable() { public void run() { abrirTela(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())); } });
        }
        @JavascriptInterface public void testar() {
            Vigia.notificar(MainActivity.this, "Radar Notícias · teste", "Assim chega um aviso de notícia relevante. Toque para abrir.", SITE, 1);
        }
        /** Lê um site para a página (sites e cidades que você adicionou); responde em radarResposta(id, ok, texto). */
        @JavascriptInterface public void baixar(final int id, final String url) {
            new Thread(new Runnable() { public void run() {
                boolean ok = false; String txt;
                try {
                    if (!url.startsWith("https://") && !url.startsWith("http://")) throw new Exception("endereço inválido");
                    txt = Vigia.baixarTexto(url); ok = true;
                } catch (Exception e) { txt = String.valueOf(e.getMessage()); }
                final String js = "window.radarResposta && radarResposta(" + id + "," + ok + "," + JSONObject.quote(txt) + ")";
                runOnUiThread(new Runnable() { public void run() { if (web != null) web.evaluateJavascript(js, null); } });
            } }).start();
        }
        /** Suas coleções viram atalhos ao segurar o ícone do app (junto de Buscar, Manchetes e Vídeos). */
        @JavascriptInterface public void atalhos(String json) {
            if (Build.VERSION.SDK_INT < 25) return;
            try {
                org.json.JSONArray a = new org.json.JSONArray(json);
                java.util.List<android.content.pm.ShortcutInfo> l = new java.util.ArrayList<>();
                for (int k = 0; k < a.length() && k < 2; k++) {
                    JSONObject c = a.getJSONObject(k);
                    l.add(new android.content.pm.ShortcutInfo.Builder(MainActivity.this, "colecao-" + c.getString("id"))
                        .setShortLabel(c.getString("nome").isEmpty() ? "Coleção" : c.getString("nome"))
                        .setIcon(android.graphics.drawable.Icon.createWithResource(MainActivity.this, R.drawable.sc_colecao))
                        .setIntent(new Intent(Intent.ACTION_VIEW, Uri.parse("radar:colecao/" + c.getString("id"))).setClass(MainActivity.this, MainActivity.class))
                        .setRank(10 + k).build());
                }
                getSystemService(android.content.pm.ShortcutManager.class).setDynamicShortcuts(l);
            } catch (Exception e) { /* atalho é extra: sem ele o app segue normal */ }
        }
        /** Erros guardados pelo app (o celular não mostra o log): Alertas e ajustes > Último erro do app. */
        @JavascriptInterface public String erros() {
            return getSharedPreferences("radar", MODE_PRIVATE).getString("erros", "");
        }
        @JavascriptInterface public void limparErros() {
            getSharedPreferences("radar", MODE_PRIVATE).edit().remove("erros").apply();
        }
        /** Erro de JavaScript da página, para ficar no mesmo registro. */
        @JavascriptInterface public void erroPagina(String txt) {
            Radar.registrar(MainActivity.this, "erro na página", new Exception(String.valueOf(txt)));
        }
        /** Leitor: "Salvar em PDF" abre a impressão do Android (escolher "Salvar como PDF"). A página esconde tudo
         *  menos o texto na impressão (CSS @media print). */
        @JavascriptInterface public void imprimir(final String titulo) {
            runOnUiThread(new Runnable() { public void run() {
                try {
                    android.print.PrintManager pm = (android.print.PrintManager) getSystemService(PRINT_SERVICE);
                    String nome = (titulo == null || titulo.trim().isEmpty() ? "Radar" : titulo.trim()).replaceAll("[\\\\/:*?\"<>|]", " ");
                    if (nome.length() > 80) nome = nome.substring(0, 80);
                    pm.print(nome, web.createPrintDocumentAdapter(nome), new android.print.PrintAttributes.Builder()
                        .setMediaSize(android.print.PrintAttributes.MediaSize.ISO_A4).build());
                } catch (Throwable e) {
                    Radar.registrar(MainActivity.this, "imprimir", e);
                    Toast.makeText(MainActivity.this, "Não deu para abrir a impressão.", Toast.LENGTH_LONG).show();
                }
            } });
        }
        /** Leitor: compartilhar o link (ou o texto) com outro app. */
        @JavascriptInterface public void compartilhar(final String titulo, final String url) {
            runOnUiThread(new Runnable() { public void run() {
                abrirTela(Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain")
                    .putExtra(Intent.EXTRA_SUBJECT, titulo).putExtra(Intent.EXTRA_TEXT, titulo + "\n" + url), "Compartilhar"));
            } });
        }
        @JavascriptInterface public String versao() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return ""; }
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null) web.evaluateJavascript("window.radarVoltar ? radarVoltar() : false", new android.webkit.ValueCallback<String>() {
            public void onReceiveValue(String fechou) {
                if ("true".equals(fechou)) return;  // a página fechou o leitor ou um painel
                if (web.canGoBack()) web.goBack(); else MainActivity.super.onBackPressed();
            }
        });
        else super.onBackPressed();
    }
}
