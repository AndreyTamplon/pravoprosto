package lessonruntime

import (
	"context"

	"github.com/jackc/pgx/v5"
)

type sessionPathEntry struct {
	SeqNo    int
	NodeID   string
	NodeKind string
}

func (s *Service) ensurePathInitializedTx(ctx context.Context, tx pgx.Tx, sessionID string, node runtimeNode) error {
	var count int
	if err := tx.QueryRow(ctx, `select count(*) from lesson_session_path_entries where lesson_session_id = $1`, sessionID).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	return s.appendPathEntryTx(ctx, tx, sessionID, node, "start", nil)
}

func (s *Service) appendPathEntryTx(ctx context.Context, tx pgx.Tx, sessionID string, node runtimeNode, enteredVia string, decisionOptionID *string) error {
	var nextSeq int
	if err := tx.QueryRow(ctx, `
		select coalesce(max(seq_no), 0) + 1
		from lesson_session_path_entries
		where lesson_session_id = $1
	`, sessionID).Scan(&nextSeq); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		insert into lesson_session_path_entries(lesson_session_id, seq_no, node_id, node_kind, entered_via, decision_option_id, active)
		values ($1, $2, $3, $4, $5, $6, true)
	`, sessionID, nextSeq, node.ID, node.Kind, enteredVia, decisionOptionID)
	return err
}

func latestActivePathEntry(ctx context.Context, db txLike, sessionID string) (sessionPathEntry, bool, error) {
	var entry sessionPathEntry
	err := db.QueryRow(ctx, `
		select seq_no, node_id, node_kind
		from lesson_session_path_entries
		where lesson_session_id = $1 and active = true
		order by seq_no desc
		limit 1
	`, sessionID).Scan(&entry.SeqNo, &entry.NodeID, &entry.NodeKind)
	if err == pgx.ErrNoRows {
		return sessionPathEntry{}, false, nil
	}
	if err != nil {
		return sessionPathEntry{}, false, err
	}
	return entry, true, nil
}

func navigationForSession(ctx context.Context, db txLike, sessionID string, currentNodeID string) (StepNavigation, error) {
	currentEntry, ok, err := latestActivePathEntry(ctx, db, sessionID)
	if err != nil || !ok || currentEntry.NodeID != currentNodeID {
		return StepNavigation{}, err
	}

	var backNodeID string
	err = db.QueryRow(ctx, `
		select node_id
		from lesson_session_path_entries
		where lesson_session_id = $1 and active = true and node_kind = 'decision' and seq_no < $2
		order by seq_no desc
		limit 1
	`, sessionID, currentEntry.SeqNo).Scan(&backNodeID)
	if err == pgx.ErrNoRows {
		return StepNavigation{}, nil
	}
	if err != nil {
		return StepNavigation{}, err
	}

	backKind := "decision"
	return StepNavigation{
		CanGoBack:        true,
		BackKind:         &backKind,
		BackTargetNodeID: &backNodeID,
	}, nil
}

func priorDecisionEntryTx(ctx context.Context, tx pgx.Tx, sessionID string, currentSeq int) (sessionPathEntry, bool, error) {
	var entry sessionPathEntry
	err := tx.QueryRow(ctx, `
		select seq_no, node_id, node_kind
		from lesson_session_path_entries
		where lesson_session_id = $1 and active = true and node_kind = 'decision' and seq_no < $2
		order by seq_no desc
		limit 1
	`, sessionID, currentSeq).Scan(&entry.SeqNo, &entry.NodeID, &entry.NodeKind)
	if err == pgx.ErrNoRows {
		return sessionPathEntry{}, false, nil
	}
	if err != nil {
		return sessionPathEntry{}, false, err
	}
	return entry, true, nil
}

func withNavigation(ctx context.Context, db txLike, sessionID string, currentNodeID string, step StepView) (StepView, error) {
	navigation, err := navigationForSession(ctx, db, sessionID, currentNodeID)
	if err != nil {
		return StepView{}, err
	}
	step.Navigation = navigation
	return step, nil
}
