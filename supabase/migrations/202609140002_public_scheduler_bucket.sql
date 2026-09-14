insert into storage.buckets (id, name, public)
values ('scheduler', 'scheduler', true)
on conflict (id)
do update set public = true;
