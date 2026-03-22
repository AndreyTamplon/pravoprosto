alter table guardian_link_invites
    add column if not exists token_encrypted text null;
