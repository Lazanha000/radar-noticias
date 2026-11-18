package br.radarnoticias;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.SizeF;
import android.widget.RemoteViews;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/** Widget "Principais notícias": se adapta ao tamanho que você der (1x1 = ícone, baixo = uma manchete,
 *  maior = lista). Os dados vêm de widget.json (um assunto por linha, já sem repetição). */
public class WidgetPrincipais extends AppWidgetProvider {
    static final String ATUALIZAR = "br.radarnoticias.WIDGET_ATUALIZAR";
    static final int FLAG_MUTAVEL = Build.VERSION.SDK_INT >= 31 ? 1 << 25 : 0;  // PendingIntent.FLAG_MUTABLE

    static JSONArray itens(Context c) {
        try { return new JSONArray(c.getSharedPreferences("radar", Context.MODE_PRIVATE).getString("widget", "[]")); }
        catch (Exception e) { return new JSONArray(); }
    }

    /** Baixa widget.json e redesenha todos os widgets. Chamado pelo próprio widget, pelo app e pelo Vigia. */
    static void baixarEAtualizar(Context c) {
        try {
            JSONArray its = new JSONObject(Vigia.baixarTexto(MainActivity.SITE + "widget.json?t=" + System.currentTimeMillis())).getJSONArray("itens");
            c.getSharedPreferences("radar", Context.MODE_PRIVATE).edit().putString("widget", its.toString()).apply();
        } catch (Exception e) { /* sem internet: fica o que já tinha */ }
        redesenhar(c);
    }

    static void redesenhar(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        int[] ids = m.getAppWidgetIds(new ComponentName(c, WidgetPrincipais.class));
        for (int id : ids) m.updateAppWidget(id, montar(c, id, m.getAppWidgetOptions(id)));
        m.notifyAppWidgetViewDataChanged(ids, R.id.lista);
    }

    static PendingIntent abrirApp(Context c, String hash, int req) {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("radar:" + hash)).setClass(c, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, req, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static RemoteViews mini(Context c) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.w_mini);
        v.setOnClickPendingIntent(R.id.raiz, abrirApp(c, "inicio", 1));
        return v;
    }

    static RemoteViews linha(Context c) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.w_linha);
        JSONObject p = itens(c).optJSONObject(0);
        if (p != null) {
            v.setTextViewText(R.id.fonte, p.optString("f") + (p.optInt("nf", 1) > 1 ? " · " + p.optInt("nf") + " veículos" : ""));
            v.setTextViewText(R.id.titulo, p.optString("t"));
            v.setOnClickPendingIntent(R.id.raiz, PendingIntent.getActivity(c, 2, new Intent(Intent.ACTION_VIEW, Uri.parse(p.optString("u"))),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        } else v.setOnClickPendingIntent(R.id.raiz, abrirApp(c, "inicio", 2));
        return v;
    }

    static RemoteViews lista(Context c, int id) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.w_lista);
        Intent servico = new Intent(c, WidgetServico.class).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
        servico.setData(Uri.parse("radar://widget/" + id));  // um adaptador por widget
        v.setRemoteAdapter(R.id.lista, servico);
        v.setEmptyView(R.id.lista, R.id.vazio);
        v.setPendingIntentTemplate(R.id.lista, PendingIntent.getActivity(c, 3, new Intent(Intent.ACTION_VIEW),
            PendingIntent.FLAG_UPDATE_CURRENT | FLAG_MUTAVEL));
        v.setOnClickPendingIntent(R.id.cabeca, abrirApp(c, "inicio", 4));
        v.setOnClickPendingIntent(R.id.atualizar, PendingIntent.getBroadcast(c, 5,
            new Intent(c, WidgetPrincipais.class).setAction(ATUALIZAR), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        return v;
    }

    /** Android 12+: o próprio sistema escolhe o layout conforme o tamanho; antes, escolhemos pelo tamanho mínimo informado. */
    static RemoteViews montar(Context c, int id, Bundle op) {
        if (Build.VERSION.SDK_INT >= 31) {
            Map<SizeF, RemoteViews> m = new HashMap<>();
            m.put(new SizeF(40, 40), mini(c));
            m.put(new SizeF(150, 40), linha(c));
            m.put(new SizeF(150, 130), lista(c, id));
            return new RemoteViews(m);
        }
        int l = op.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250), a = op.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 180);
        if (l < 150) return mini(c);
        if (a < 130) return linha(c);
        return lista(c, id);
    }

    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        for (int id : ids) m.updateAppWidget(id, montar(c, id, m.getAppWidgetOptions(id)));
        final PendingResult r = goAsync();
        final Context app = c.getApplicationContext();
        new Thread(new Runnable() { public void run() { baixarEAtualizar(app); r.finish(); } }).start();
    }

    @Override
    public void onAppWidgetOptionsChanged(Context c, AppWidgetManager m, int id, Bundle op) {
        m.updateAppWidget(id, montar(c, id, op));
    }

    @Override
    public void onReceive(Context c, Intent i) {
        if (ATUALIZAR.equals(i.getAction())) {
            final PendingResult r = goAsync();
            final Context app = c.getApplicationContext();
            new Thread(new Runnable() { public void run() { baixarEAtualizar(app); r.finish(); } }).start();
            return;
        }
        super.onReceive(c, i);
    }
}
