package br.radarnoticias;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;
import org.json.JSONArray;
import org.json.JSONObject;

/** Linhas da lista do widget "Principais notícias". */
public class WidgetServico extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Fabrica(getApplicationContext());
    }

    static int cor(String ala) {
        switch (ala) {
            case "radical": return 0xFFF0767B;
            case "moderada": return 0xFFF2A0B6;
            case "direita": return 0xFF8FB2F0;
            default: return 0xFFB4BCB8;
        }
    }

    static String quando(long ts) {
        long s = System.currentTimeMillis() / 1000 - ts;
        if (s < 3600) return "há " + Math.max(1, s / 60) + " min";
        if (s < 86400) return "há " + (s / 3600) + " h";
        return "há " + (s / 86400) + " d";
    }

    static class Fabrica implements RemoteViewsFactory {
        final Context c;
        JSONArray its = new JSONArray();
        Fabrica(Context c) { this.c = c; }

        public void onCreate() {}
        public void onDataSetChanged() { its = WidgetPrincipais.itens(c); }
        public void onDestroy() {}
        public int getCount() { return its.length(); }
        public RemoteViews getLoadingView() { return null; }
        public int getViewTypeCount() { return 1; }
        public long getItemId(int p) { return p; }
        public boolean hasStableIds() { return false; }

        public RemoteViews getViewAt(int p) {
            JSONObject i = its.optJSONObject(p);
            RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.w_item);
            if (i == null) return v;
            int nf = i.optInt("nf", 1);
            v.setTextViewText(R.id.fonte, i.optString("f") + " · " + quando(i.optLong("ts")) + (nf > 1 ? " · " + nf + " veículos" : ""));
            v.setTextViewText(R.id.titulo, i.optString("t"));
            v.setInt(R.id.ala, "setColorFilter", cor(i.optString("ala")));
            v.setOnClickFillInIntent(R.id.item, new Intent().setData(Uri.parse(i.optString("u"))));
            return v;
        }
    }
}
