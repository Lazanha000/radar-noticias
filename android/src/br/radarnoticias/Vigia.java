package br.radarnoticias;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Em segundo plano, a cada N minutos: baixa alertas.json (notícias das últimas 6 h, já com o tamanho do grupo
 *  de cada uma) e avisa as que passam nos ajustes feitos no app. Cada fato é avisado uma vez só. */
public class Vigia extends JobService {
    static final int JOB = 1;
    static final String CANAL = "relevantes";

    static void agendar(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        JSONObject a = ajustes(c);
        if (a == null || !a.optBoolean("ativo")) { js.cancel(JOB); return; }
        long ms = Math.max(15, a.optInt("intervalo", 30)) * 60_000L;
        JobInfo atual = js.getPendingJob(JOB);
        if (atual != null && atual.getIntervalMillis() == ms) return;
        js.schedule(new JobInfo.Builder(JOB, new ComponentName(c, Vigia.class)).setPeriodic(ms)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true).build());
    }

    static JSONObject ajustes(Context c) {
        try { return new JSONObject(c.getSharedPreferences("radar", MODE_PRIVATE).getString("alertas", "")); } catch (Exception e) { return null; }
    }

    @Override
    public boolean onStartJob(JobParameters p) {
        final JobParameters params = p;
        new Thread(new Runnable() { public void run() {
            try { verificar(Vigia.this); } catch (Exception e) { /* sem internet: tenta na próxima */ }
            catch (Throwable e) { Radar.registrar(Vigia.this, "alertas em segundo plano", e); }
            try { WidgetPrincipais.baixarEAtualizar(Vigia.this); }  // aproveita para atualizar os widgets
            catch (Throwable e) { Radar.registrar(Vigia.this, "widget em segundo plano", e); }
            try { jobFinished(params, false); } catch (Throwable e) { }
        } }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters p) { return true; }

    static final String UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

    /** Baixa um texto (feed, JSON ou página para o leitor): segue redirecionamentos (também http -> https),
     *  usa a codificação que o site declara (cabeçalho ou <meta charset>) e para em 8 MB. */
    static String baixarTexto(String url) throws Exception {
        for (int pulo = 0; pulo < 6; pulo++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(20000); c.setReadTimeout(30000);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("User-Agent", UA);
            c.setRequestProperty("Accept-Language", "pt-BR,pt;q=0.9,en;q=0.6");
            int st = c.getResponseCode();
            if (st >= 300 && st < 400 && c.getHeaderField("Location") != null) {
                url = new URL(new URL(url), c.getHeaderField("Location")).toString();
                c.disconnect();
                continue;
            }
            if (st >= 400) { c.disconnect(); throw new Exception("HTTP " + st); }
            byte[] bytes;
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream o = new ByteArrayOutputStream();
                byte[] b = new byte[16384];
                for (int n; (n = in.read(b)) > 0; ) {
                    o.write(b, 0, n);
                    if (o.size() > 8 << 20) throw new Exception("página grande demais");
                }
                bytes = o.toByteArray();
            }
            return decodificar(bytes, c.getContentType());
        }
        throw new Exception("redirecionamentos demais");
    }

    static String decodificar(byte[] bytes, String tipo) {
        String cs = null;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("charset=[\"']?([\\w-]+)", java.util.regex.Pattern.CASE_INSENSITIVE)
            .matcher(tipo == null ? "" : tipo);
        if (m.find()) cs = m.group(1);
        if (cs == null) {  // <meta charset="..."> nos primeiros 2 KB
            m = java.util.regex.Pattern.compile("charset=[\"']?([\\w-]+)", java.util.regex.Pattern.CASE_INSENSITIVE)
                .matcher(new String(bytes, 0, Math.min(bytes.length, 2048), java.nio.charset.StandardCharsets.ISO_8859_1));
            if (m.find()) cs = m.group(1);
        }
        try { return new String(bytes, cs == null ? "UTF-8" : cs); } catch (Exception e) { return new String(bytes, java.nio.charset.StandardCharsets.UTF_8); }
    }

    static Set<String> lista(JSONArray a) {
        Set<String> s = new HashSet<>();
        for (int i = 0; a != null && i < a.length(); i++) s.add(a.optString(i));
        return s;
    }

    static void verificar(Context c) throws Exception {
        JSONObject a = ajustes(c);
        if (a == null || !a.optBoolean("ativo")) return;
        Calendar agora = Calendar.getInstance();
        JSONArray sil = a.optJSONArray("silencio");
        if (sil != null) {
            int h = agora.get(Calendar.HOUR_OF_DAY), de = sil.optInt(0), ate = sil.optInt(1);
            if (de < ate ? (h >= de && h < ate) : (h >= de || h < ate)) return;
        }
        SharedPreferences sp = c.getSharedPreferences("radar", MODE_PRIVATE);
        String hoje = String.format("%tF", agora);
        int feitosHoje = hoje.equals(sp.getString("dia", "")) ? sp.getInt("feitosHoje", 0) : 0;
        int max = a.optInt("maxDia", 6);
        if (feitosHoje >= max) return;

        Set<String> fontes = lista(a.optJSONArray("fontes"));
        Set<String> temas = a.isNull("temas") ? null : lista(a.optJSONArray("temas"));
        int minFontes = a.optInt("minFontes", 3);
        JSONObject qualquer = a.optJSONObject("qualquer");
        JSONArray avisadas = new JSONArray(sp.getString("avisadas", "[]"));
        Set<String> jaAvisou = lista(avisadas);
        boolean primeiraVez = !sp.contains("avisadas");

        JSONArray itens = new JSONObject(baixarTexto(MainActivity.SITE + "alertas.json?t=" + System.currentTimeMillis())).getJSONArray("itens");
        long limite = System.currentTimeMillis() / 1000 - 3 * 3600;  // só fatos com notícia nas últimas 3 h
        Map<String, List<JSONObject>> grupos = new LinkedHashMap<>();
        for (int i = 0; i < itens.length(); i++) {
            JSONObject it = itens.getJSONObject(i);
            String k = it.optInt("g") > 0 ? "g" + it.optInt("g") : it.optString("u");
            List<JSONObject> l = grupos.get(k);
            if (l == null) grupos.put(k, l = new ArrayList<>());
            l.add(it);
        }
        List<String> novas = new ArrayList<>();
        for (List<JSONObject> g : grupos.values()) {
            boolean recente = false, avisado = false, temaOk = temas == null;
            int nf = 1, na = 1;
            JSONObject escolhida = null;
            for (JSONObject it : g) {
                recente |= it.optLong("ts") >= limite;
                avisado |= jaAvisou.contains(it.optString("u"));
                nf = Math.max(nf, it.optInt("nf", 1)); na = Math.max(na, it.optInt("na", 1));
                JSONArray tm = it.optJSONArray("tm");
                for (int j = 0; !temaOk && tm != null && j < tm.length(); j++) temaOk = temas.contains(tm.optString(j));
                if (escolhida == null && fontes.contains(it.optString("f"))) escolhida = it;
            }
            if (!recente || avisado) continue;
            boolean vale = escolhida != null && nf >= minFontes && temaOk;
            if (!vale && qualquer != null && nf >= qualquer.optInt("nf", 8) && na >= qualquer.optInt("na", 3)) { vale = true; escolhida = g.get(0); }
            if (!vale) continue;
            for (JSONObject it : g) novas.add(it.optString("u"));
            if (primeiraVez) continue;  // ao ligar os alertas, não despeja o que já tinha saído
            String titulo = escolhida.optString("nome") + (nf > 1 ? " · " + nf + " veículos" : "");
            notificar(c, titulo, escolhida.optString("t"), escolhida.optString("u"), escolhida.optString("u").hashCode());
            if (++feitosHoje >= max) break;
        }
        for (String u : novas) avisadas.put(u);
        while (avisadas.length() > 600) avisadas.remove(0);
        sp.edit().putString("avisadas", avisadas.toString()).putString("dia", hoje).putInt("feitosHoje", feitosHoje).apply();
    }

    @SuppressWarnings("deprecation")
    static void notificar(Context c, String titulo, String texto, String url, int id) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CANAL, "Notícias relevantes", NotificationManager.IMPORTANCE_DEFAULT));
            b = new Notification.Builder(c, CANAL);
        } else b = new Notification.Builder(c);
        PendingIntent abrir = PendingIntent.getActivity(c, id, new Intent(Intent.ACTION_VIEW, Uri.parse(url)),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        nm.notify(id, b.setSmallIcon(R.drawable.ic_notif).setColor(0xFF0A7471).setContentTitle(titulo).setContentText(texto)
            .setStyle(new Notification.BigTextStyle().bigText(texto)).setContentIntent(abrir).setAutoCancel(true).build());
    }
}
