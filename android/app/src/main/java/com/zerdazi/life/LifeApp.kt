package com.zerdazi.life

import android.app.Application
import android.content.Context
import com.zerdazi.life.server.Db
import com.zerdazi.life.server.LocalApi

class LifeApp : Application() {
    override fun onCreate() {
        super.onCreate()
        ctx = this
        Db.init(this)
        LocalApi.init(this)
    }

    companion object {
        lateinit var ctx: Context
            private set
    }
}
