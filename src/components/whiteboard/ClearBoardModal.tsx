import ConfirmDialog from '../ConfirmDialog';

type ClearBoardModalProps = {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ClearBoardModal({
  isOpen,
  onConfirm,
  onCancel,
}: ClearBoardModalProps) {
  return (
    <ConfirmDialog
      isOpen={isOpen}
      title="Clear all boards"
      body="This will erase every board in this room for all users. Are you sure?"
      confirmLabel="Clear all boards"
      testIdPrefix="whiteboard-clear"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
