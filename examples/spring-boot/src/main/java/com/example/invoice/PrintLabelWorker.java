package com.example.invoice;

import java.util.List;

import org.operaton.bpm.engine.ProcessEngine;
import org.operaton.bpm.engine.externaltask.LockedExternalTask;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Completes "print-label" external tasks from inside the same JVM as the
 * embedded engine, so the shipment-label process reaches its end event without a
 * separate worker deployment. It polls the engine's external-task service on a
 * fixed delay and completes any task locked on the topic.
 */
@Component
public class PrintLabelWorker {

    private static final Logger LOG = LoggerFactory.getLogger(PrintLabelWorker.class);
    private static final String WORKER_ID = "print-label-worker";
    private static final String TOPIC = "print-label";

    private final ProcessEngine engine;

    public PrintLabelWorker(ProcessEngine engine) {
        this.engine = engine;
    }

    @Scheduled(fixedDelay = 2000)
    public void completePrintLabelTasks() {
        List<LockedExternalTask> tasks = engine.getExternalTaskService()
                .fetchAndLock(10, WORKER_ID)
                .topic(TOPIC, 60_000)
                .execute();
        for (LockedExternalTask task : tasks) {
            LOG.info("PrintLabel: completing external task {}", task.getId());
            engine.getExternalTaskService().complete(task.getId(), WORKER_ID);
        }
    }
}
