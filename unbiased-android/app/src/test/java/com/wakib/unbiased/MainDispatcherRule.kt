package com.wakib.unbiased

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.rules.TestWatcher
import org.junit.runner.Description

// Exposes its dispatcher so tests can pass it to runTest(dispatcher) { ... }.
// That makes Dispatchers.Main and the test body share one TestCoroutineScheduler,
// which is what lets runTest auto-pump viewModelScope's internal
// stateIn(WhileSubscribed) sharing coroutine while the test coroutine is
// suspended (e.g. inside Turbine's awaitItem()). Without a shared scheduler,
// that internal coroutine never gets a chance to run and tests hang/timeout.
@OptIn(ExperimentalCoroutinesApi::class)
class MainDispatcherRule(
    val dispatcher: TestDispatcher = StandardTestDispatcher()
) : TestWatcher() {
    override fun starting(description: Description) {
        Dispatchers.setMain(dispatcher)
    }

    override fun finished(description: Description) {
        Dispatchers.resetMain()
    }
}
