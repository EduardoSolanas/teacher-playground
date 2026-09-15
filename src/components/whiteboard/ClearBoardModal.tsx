import ConfirmDialog from '../ConfirmDialog';

type ClearBoardModalProps = {
  isOpen: boolean;
  /** The board the button will empty; the dialog names it. */
  boardName: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ClearBoardModal({
  isOpen,
  boardName,
  onConfirm,
  onCancel,
}: ClearBoardModalProps) {
  return (
    <ConfirmDialog
      isOpen={isOpen}
      title="Clear this board"
      body={`This will erase everything on '${boardName}' for all users. Are you sure?`}
      confirmLabel="Clear board"
      testIdPrefix="whiteboard-clear"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
